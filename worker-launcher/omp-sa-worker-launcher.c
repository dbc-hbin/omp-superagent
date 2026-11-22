/*
 * omp-sa-worker-launcher: the one fixed executable of every macOS worker LaunchAgent.
 *
 * macOS attributes privacy (TCC) access to the launchd job's responsible
 * executable, and a keychain "Always Allow" binds to a binary's code identity.
 * Both are granted once by the owner, so the LaunchAgent must always run THIS
 * binary, installed once at a stable path and never replaced on upgrades. It
 * is built from this file, ad-hoc signed once (identifier
 * com.omp-superagent.worker-launcher) and does nothing else:
 *
 *   omp-sa-worker-launcher --status FILE -- ARG...
 *     1. Reads the private payload pointer ../payload next to its own bin/
 *        directory: one argv entry per line, the first an absolute path (bun)
 *        followed by its fixed arguments (the versioned release). Refuses
 *        (exit 78) unless the support directory is owned by the user with no
 *        group/other access and the pointer is a regular file owned by the
 *        user with mode 0600 and one link.
 *     2. Runs the payload with ARG... appended as a CHILD (never exec: after an
 *        exec the process would carry bun's identity, not this one) and waits.
 *     3. Writes the payload's exit status to FILE (atomically, mode 0600) so
 *        the caller can read it without the job ending.
 *     4. Stays alive while any process still names this launcher as its
 *        responsible process (the detached worker Host and its tools: a
 *        responsible process that exited would hand attribution back to bun or
 *        omp, whose paths and signatures change on upgrade), then removes its
 *        own launchd job and exits.
 *
 *   omp-sa-worker-launcher --probe PATH
 *     Lists a directory with this binary's own identity. One-time setup uses it
 *     to raise a privacy prompt for the launcher exactly once. Exit 0 readable,
 *     1 denied, 2 other error.
 *
 * The pointer is the only thing an upgrade changes.
 */
#include <errno.h>
#include <fcntl.h>
#include <dirent.h>
#include <libproc.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#define EX_REFUSED 78
#define MAX_POINTER 16384
#define MAX_PAYLOAD 32
#define LABEL_PREFIX "com.omp-superagent.worker."

extern char **environ;
extern pid_t responsibility_get_pid_responsible_for_pid(pid_t) __attribute__((weak_import));

static const char *status_path;
static volatile sig_atomic_t child_pid = -1;

static void forward(int signal_number) {
  if (child_pid > 0) kill((pid_t)child_pid, signal_number);
  else _exit(128 + signal_number);
}

static void write_status(int code) {
  if (!status_path) return;
  char temporary[PATH_MAX];
  if (snprintf(temporary, sizeof temporary, "%s.tmp", status_path) >= (int)sizeof temporary) return;
  int fd = open(temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) { fprintf(stderr, "omp-sa-worker-launcher: status: %s\n", strerror(errno)); return; }
  char text[32];
  int length = snprintf(text, sizeof text, "%d\n", code);
  if (write(fd, text, (size_t)length) != length) fprintf(stderr, "omp-sa-worker-launcher: status write failed\n");
  close(fd);
  if (rename(temporary, status_path) != 0) fprintf(stderr, "omp-sa-worker-launcher: status: %s\n", strerror(errno));
}

static int holds_children(void) {
  if (!responsibility_get_pid_responsible_for_pid) return 0;
  static pid_t pids[1 << 16];
  int count = proc_listallpids(pids, (int)sizeof pids);
  pid_t self = getpid();
  for (int index = 0; index < count; index++) {
    if (pids[index] != self && pids[index] > 0 && responsibility_get_pid_responsible_for_pid(pids[index]) == self) return 1;
  }
  return 0;
}

/* Ends this launcher's own (already-run) launchd job; the job is named by the manager. */
static void remove_own_job(void) {
  const char *label = getenv("XPC_SERVICE_NAME");
  if (!label || strncmp(label, LABEL_PREFIX, strlen(LABEL_PREFIX)) != 0) return;
  char target[PATH_MAX];
  if (snprintf(target, sizeof target, "gui/%u/%s", (unsigned)getuid(), label) >= (int)sizeof target) return;
  char *args[] = { "launchctl", "bootout", target, NULL };
  pid_t pid;
  if (posix_spawn(&pid, "/bin/launchctl", NULL, NULL, args, environ) == 0) {
    int status;
    waitpid(pid, &status, 0);
  }
}

static int finish(int code) {
  write_status(code);
  while (holds_children()) sleep(1);
  remove_own_job();
  return code;
}

static int refuse(const char *reason) {
  fprintf(stderr, "omp-sa-worker-launcher: refused: %s\n", reason);
  return finish(EX_REFUSED);
}

static int private_directory(const char *path) {
  struct stat info;
  return lstat(path, &info) == 0 && S_ISDIR(info.st_mode) && info.st_uid == getuid() && (info.st_mode & 077) == 0;
}

/* Fills `entries` from the pointer; entries point into `buffer`. Returns the count or -1 with `*why` set. */
static int load_payload(char *buffer, char **entries, const char **why) {
  char executable[PATH_MAX], resolved[PATH_MAX];
  uint32_t size = sizeof executable;
  if (_NSGetExecutablePath(executable, &size) != 0 || !realpath(executable, resolved)) { *why = "cannot resolve own path"; return -1; }
  char support[PATH_MAX];
  if (snprintf(support, sizeof support, "%s", resolved) >= (int)sizeof support) { *why = "path too long"; return -1; }
  /* <support>/bin/omp-sa-worker-launcher */
  char *slash = strrchr(support, '/');
  if (!slash) { *why = "unexpected install path"; return -1; }
  *slash = 0;
  slash = strrchr(support, '/');
  if (!slash) { *why = "unexpected install path"; return -1; }
  *slash = 0;
  char pointer[PATH_MAX];
  if (snprintf(pointer, sizeof pointer, "%s/payload", support) >= (int)sizeof pointer) { *why = "path too long"; return -1; }
  if (!private_directory(support)) { *why = "support directory must be owned by the user with mode 0700"; return -1; }
  int fd = open(pointer, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) { *why = "payload pointer is missing"; return -1; }
  struct stat info;
  if (fstat(fd, &info) != 0 || !S_ISREG(info.st_mode) || info.st_uid != getuid() || (info.st_mode & 0777) != 0600
      || info.st_nlink != 1 || info.st_size < 1 || info.st_size > MAX_POINTER) {
    close(fd);
    *why = "payload pointer must be a regular file owned by the user with mode 0600";
    return -1;
  }
  ssize_t length = read(fd, buffer, MAX_POINTER);
  close(fd);
  if (length != info.st_size) { *why = "payload pointer could not be read"; return -1; }
  buffer[length] = 0;
  int count = 0;
  char *line = buffer;
  while (line < buffer + length) {
    char *end = memchr(line, '\n', (size_t)(buffer + length - line));
    if (end) *end = 0;
    size_t width = strlen(line);
    if (width == 0 || (!end && line + width != buffer + length) || (end && line + width != end)) { *why = "payload pointer has an empty or binary entry"; return -1; }
    if (count == MAX_PAYLOAD) { *why = "payload pointer has too many entries"; return -1; }
    entries[count++] = line;
    line = end ? end + 1 : buffer + length;
  }
  if (count == 0 || entries[0][0] != '/') { *why = "payload must start with an absolute executable path"; return -1; }
  return count;
}

static int probe(const char *path) {
  DIR *directory = opendir(path);
  if (!directory) {
    fprintf(stderr, "omp-sa-worker-launcher: %s: %s\n", path, strerror(errno));
    return errno == EPERM || errno == EACCES ? 1 : 2;
  }
  errno = 0;
  readdir(directory);
  int code = errno == EPERM || errno == EACCES ? 1 : 0;
  closedir(directory);
  return code;
}

int main(int argc, char **argv) {
  if (argc == 3 && strcmp(argv[1], "--probe") == 0) return probe(argv[2]);
  int first = 1;
  if (argc > 2 && strcmp(argv[1], "--status") == 0) { status_path = argv[2]; first = 3; }
  if (first >= argc || strcmp(argv[first], "--") != 0) {
    fprintf(stderr, "usage: omp-sa-worker-launcher [--status FILE] -- ARG...\n       omp-sa-worker-launcher --probe PATH\n");
    return finish(64);
  }
  first++;

  static char buffer[MAX_POINTER + 1];
  char *entries[MAX_PAYLOAD + 1];
  const char *why = NULL;
  int count = load_payload(buffer, entries, &why);
  if (count < 0) return refuse(why);

  char *spawned[MAX_PAYLOAD + 1 + 64];
  int total = 0;
  for (int index = 0; index < count; index++) spawned[total++] = entries[index];
  if (total + (argc - first) >= (int)(sizeof spawned / sizeof *spawned)) return refuse("too many arguments");
  for (int index = first; index < argc; index++) spawned[total++] = argv[index];
  spawned[total] = NULL;

  struct sigaction action = { .sa_handler = forward };
  sigemptyset(&action.sa_mask);
  pid_t pid;
  int error = posix_spawn(&pid, entries[0], NULL, NULL, spawned, environ);
  if (error != 0) { fprintf(stderr, "omp-sa-worker-launcher: cannot run payload: %s\n", strerror(error)); return finish(126); }
  child_pid = pid;
  sigaction(SIGTERM, &action, NULL);
  sigaction(SIGINT, &action, NULL);
  int status = 0;
  while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
  child_pid = -1;
  return finish(WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status));
}
