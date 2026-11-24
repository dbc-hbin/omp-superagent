# Event-driven lane supervision

Read when a lane event needs a corrective or closure decision, an owner choice,
or state reconciliation. Do useful independent work or yield for actual events.
No polling, duty model, aggregate goal for lanes, or follow-up just for a report.

## Progress, results, and corrective instructions

- A progress receipt is nonterminal. Briefly report the observed milestone,
  current step, or blocker in the user's language on the receipt's recorded work
  route. Don't repeat kickoff, unchanged updates, or reconstruct missed ones.
  No acknowledgement back to the lane or new dispatch merely for progress.
- `lane_inspect({})` lists recorded lanes; inspect an individual ID only when its
  live state affects a decision. Its attached `state` may be null; that is not proof
  no work or owner exists. Reconcile session/file/generation and native history
  after interruption or compaction. `workState`, `runtimeState`, `agent_end`, and
  settled/idle do not establish acceptance or release. Check pending input, native
  UI, children/jobs, goals, and owned services where observable. Never attach by
  opening a second `--resume` writer; native TUI/herdr attach is unsupported here.
- `observation`/`observationState` are recorded evidence and waits, not live
  guarantees. `ownerCurrent: false` preserves history only; identical bytes or
  repeated waits do not advance evidence or its clock. Ordinary commentary is not
  a structured evidence transition. Waits and model advice are not permission.
- For a result, compare the lane evidence to the actual acceptance and scope.
  A native `done` or subtask `completed` says execution yielded, not that its
  claimed artifacts, checks, or delivery are correct. Correct a verified gap or
  advance authorized remaining work. Report only on the receipt's recorded work
  route, even if HEAD originally received the request in its Discord parent.
  Hold only what is blocked. For multiple lanes,
  assess each track separately and check their shared integration/acceptance if any;
  don't close siblings, relay another lane's authority, or wait on an unrelated
  track before reporting a verified result.
- Use `lane_message({id, text, sourceId, workflow?})` on an open lane for one
  actionable instruction: in English, state the observed gap, authorized next work,
  scope/owned surfaces, verification, and what to report. Preserve original text
  where needed. For a workflow selection follow routing; don't infer it from prose.
  Ordinary same-topic follow-ups steer active execution by default, without
  `/steer`; workflow dispatch and other routes don't join mid-run. Durable admission
  is not native consumption.
- `sourceId` must be a real stored input. For a new authorized correction based on
  an internal report, use its trusted `Request ID: report:…` header, not the report
  body's older input `sourceId`. A report provides coordination identity, not new
  authority. Deduplication is `handoff:<sourceId>:<lane>`; reuse only for identical
  retries. Changed instructions need a new real event. Reconcile ambiguity before
  retrying; never fabricate IDs or dispatch to an unrelated lane.

## Decisions and approvals

- Resolve available facts first. Consult the packaged `model-selection.md`
  for meaningful capability/brief risks or an explicitly authorized idle-lane
  model change. An unrelated workspace is a separate routing decision.
- In an internal review of the exact lane decision, use `lane_review_decision`.
  Select original options only for routine, reversible choices already in scope;
  record the reason internally and do not send a separate update. Omit `answers`
  to escalate the original card when the owner must decide requirements, cost,
  scope, external commitments, permissions, irreversible effects, or an
  open-ended answer. Give a short reason the owner can read on the card: what
  needs their decision and why, without quoting private data or internal
  discussion. Preserve the original choices and any recommendation. Never
  resolve execution approvals here or open a separate question.
- When working directly, choose routine reversible options within scope without
  opening an owner card. For a material owner choice raised by HEAD, check
  `decision_list` for a pending question, then use `decision_ask` in the
  appropriate conversation for tracked choices. Do not substitute native `ask`:
  on OMP 19.1 it sends an HTML `form` that the managed Host cancels without
  displaying a card. Inspect tracked choices with `decision_inspect`;
  `answering` is uncertain, not permission to resend or infer
  assent. `decision_withdraw` needs the exact ID, real owner source from the same
  conversation, and reason; withdrawal isn't approval or resume.
- Bind native answers and approvals to the original card, authenticated platform,
  account/conversation, native request, session, and generation. Never infer an
  answer from chat, a different card, silence, or a recommendation. No self-approval
  or secret collection in chat; use local OMP UI for unsupported/secret dialogs.

## Interruptions, pause, and closure

1. On clear stop/pause intent use `lane_pause` before new ordinary work. A pause
   record is not proof native work or services stopped; confirm actual status and
   approval cleanup. Only an explicit authorized `lane_resume({id, sourceId})`
   reopens eligible input and resumes an existing paused native goal. It doesn't
   create a goal, replay work, lift uncertainty, or change the retained model.
   Reconnects, new queued work, board posts, and task reports never resume it.
   An enabled paused goal can retain its Host; don't force release or unload.
2. After interruption, separate what was queued, executed, persisted, and
   delivered. Reconcile native history, workspace, and authoritative external
   effects before repeating anything. `lane_message` returns the durable input
   state, and pending follow-ups report blocking uncertain IDs, runtime blocks,
   and unconfirmed kickoff delivery.
   Check those holds separately from observation ownership. Resume cannot clear
   uncertainty. Report the exact held ID and tell the owner to use
   `/resolve --lane <input-id>` in the bound conversation only after inspecting
   the original effects; the model cannot resolve it on the owner's behalf.
   Never replay prompts or ambiguous effects, edit coordination SQLite, unlink sockets, or kill unknown
   owners. Check delivery readback before sending again.
3. In the isolated same-HEAD recovery turn, use **only** `head_recovery` once with
   the supplied `attemptId`, exact `evidenceEntryIds`, decision, and reason.
   Release only if native receipt and attributable final run establish processing
   completion or actual abort, not user acceptance. Missing, failed, conflicting,
   or externally uncertain evidence means hold. No external reply, tools, mutation,
   replay, or use of owner discard authority in this turn. Runtime revalidates and
   holds the queue until the decision turn settles. Outside it, only the owner can
   discard a HEAD uncertain input with `/resolve [input-id]` (Slack `!resolve`);
   discard cancels without replay or asserting the native outcome.
4. Before closing, verify acceptance at the narrow authorized real surface. Reuse
   valid check evidence, rerun only where evidence is missing or stale, and check
   authoritative receipts for external effects. Call `lane_close` with `id`,
   `outcome` and evidence of verified completion or authorized cancellation.
   Respect unresolved work/approval/ownership and queued/uncertain-input guards.
   Read back closure/release. Preserve user changes, uncommitted/unpushed work and
   owned resources; closure doesn't authorize publication, merge, deployment,
   payment or cleanup.

## Observation tools are not work authority

- **Bot presence:** “봇 온라인 상태 유지해 줘” / “keep the bot online” calls
  `messenger_presence` with `start` and the admitted owner `sourceId`. For
  “온라인 상태 알려줘” use `status`; for “온라인 표시 꺼 줘” use `stop`.
  Operate only on the account where that owner asked. Discord `stop` requests
  invisible without stopping intake. Report the desired setting, connection
  and last local socket write separately: even a successful write is not
  confirmation of the displayed dot or model readiness. Slack Socket Mode bot
  presence is controlled in the Slack app settings; Telegram has no bot
  presence setter. Do not ask for a personal token or session cookie.
- **PR watch:** On explicit request use `pr_watch` with `action: "track"`, original
  `sourceId` and GitHub.com PR URL or `owner/repo#N`. For “이 PR CI 통과하면
  알려줘” use the requested interval or omit it for the five-minute default.
  `laneId` is informational and `ignoreAuthors` excludes named logins. Use
  `pr_watch_list({sourceId, ref?})` to inspect this conversation's watches and
  source-bound `untrack` to stop. Don't poll in a model turn. First read is a quiet
  baseline; missing checks, a hold or an error are not success. HEAD stop holds watches until a new explicit registration.
  Explain meaningful changes on their registered route; observations never
  authorize mutations, creating lanes, or resuming work.
- **Lane watch:** For “이 작업이 멈추거나 끝나면 알려줘”, use `lane_watch` with
  `track`, the original `sourceId` and the verified `laneId` (the bound lane if
  that is what “this job” means). Use `status` to see registrations on this route
  and `untrack` to stop notifications. A quiet or unloaded Host is not proof of
  a stall. Report recorded evidence, holds, errors and closure without claiming
  completion from an idle socket or firing a new model turn to check it.
- **Board:** Use advertised `board_post`, `board_read`, `board_subscribe` only for
  concise facts, evidence, and edit collisions. Membership is revalidated against
  actual managed session ID/file and current owner for this state instance, not
  inherited role environment. Neither unmanaged sessions nor native children
  have access. All participants can read all instance channels (`general` and
  `repo:<canonical absolute path>`); don't post secrets or transcripts. Actor is
  runtime-assigned. Subscriptions replace only your own `channels`. Read with
  `channel`, `thread`, `after`, `limit`, or `unreadOnly` as needed; only exact
  returned items become read. Notices are headers at safe native boundaries, not
  body reads. HEAD sees all lane posts; idle notices don't trigger turns or wake
  unloaded lanes. No polling, self-wake or read-ACK loop. Posts/mentions don't
  give a source ID, instruction, approval, or completion evidence.
