use std::collections::HashSet;

use serde::Deserialize;

use super::rest::{Rest, broken};
use super::{Effect, EffectError, State, model::Channel};

const ADMINISTRATOR: u64 = 1 << 3;
pub(super) const VIEW_CHANNEL: u64 = 1 << 10;
pub(super) const SEND_MESSAGES: u64 = 1 << 11;
pub(super) const EMBED_LINKS: u64 = 1 << 14;
pub(super) const READ_HISTORY: u64 = 1 << 16;
pub(super) const MANAGE_THREADS: u64 = 1 << 34;
pub(super) const CREATE_PUBLIC_THREADS: u64 = 1 << 35;
pub(super) const SEND_IN_THREADS: u64 = 1 << 38;

#[derive(Deserialize)]
struct Guild {
    id: String,
    owner_id: String,
}

#[derive(Deserialize)]
struct Member {
    user: super::model::User,
    roles: HashSet<String>,
}

#[derive(Deserialize)]
struct Role {
    id: String,
    permissions: String,
}

fn bits(value: &str) -> Effect<u64> {
    value
        .parse()
        .map_err(|_| broken("Discord permission bitset is invalid"))
}

fn effective(channel: &Channel, guild: &Guild, member: &Member, roles: &[Role]) -> Effect<u64> {
    let everyone = roles
        .iter()
        .find(|role| role.id == guild.id)
        .ok_or_else(|| broken("Discord default role is missing"))?;
    let mut permission = bits(&everyone.permissions)?;
    if guild.owner_id == member.user.id {
        return Ok(u64::MAX);
    }
    let granted = roles
        .iter()
        .filter(|role| member.roles.contains(&role.id))
        .collect::<Vec<_>>();
    if granted.len() != member.roles.len() {
        return Err(broken(
            "Discord guild role list did not match the authenticated member",
        ));
    }
    for role in granted {
        permission |= bits(&role.permissions)?;
    }
    if has(permission, ADMINISTRATOR) {
        return Ok(u64::MAX);
    }
    if let Some(overwrite) = channel
        .permission_overwrites
        .iter()
        .find(|item| item.kind == 0 && item.id == guild.id)
    {
        permission = (permission & !bits(&overwrite.deny)?) | bits(&overwrite.allow)?;
    }
    let (mut deny, mut allow) = (0, 0);
    for item in &channel.permission_overwrites {
        if item.kind == 0 && item.id != guild.id && member.roles.contains(&item.id) {
            deny |= bits(&item.deny)?;
            allow |= bits(&item.allow)?;
        }
    }
    permission = (permission & !deny) | allow;
    if let Some(overwrite) = channel
        .permission_overwrites
        .iter()
        .find(|item| item.kind == 1 && item.id == member.user.id)
    {
        permission = (permission & !bits(&overwrite.deny)?) | bits(&overwrite.allow)?;
    }
    Ok(permission)
}

pub(super) fn has(permissions: u64, required: u64) -> bool {
    permissions & required == required
}

impl State {
    pub(super) async fn permissions(&self, parent: &Channel) -> Effect<u64> {
        let account = &self
            .identity
            .get()
            .ok_or_else(|| broken("Discord bot has not authenticated"))?
            .account;
        guild_permissions(&self.rest, parent, account).await
    }
}

pub(super) async fn guild_permissions(
    rest: &Rest,
    channel: &Channel,
    account: &str,
) -> Effect<u64> {
    let guild = channel
        .guild_id
        .as_deref()
        .ok_or_else(|| EffectError::rejected("Discord guild permission check requires a guild"))?;
    let guild_url = format!("guilds/{guild}");
    let member_url = format!("guilds/{guild}/members/{account}");
    let roles_url = format!("guilds/{guild}/roles");
    let (group, member, roles) = tokio::try_join!(
        rest.get::<Guild>(&guild_url),
        rest.get::<Member>(&member_url),
        rest.get::<Vec<Role>>(&roles_url),
    )?;
    if group.id != guild || member.user.id != account {
        return Err(broken(
            "Discord permissions response identity could not be verified",
        ));
    }
    effective(channel, &group, &member, &roles)
}
