use anyhow::{Context, Result, ensure};
use std::env;

fn main() -> Result<()> {
    let mut args = env::args().skip(1);
    let port: u16 = args.next().context("Missing fixture port")?.parse()?;
    let op = args.next().context("Missing fixture operation")?;
    ensure!(port != 0 && args.next().is_none(), "Invalid fixture arguments");
    omp_gateway::operator::stdio(&op, Some(port))
}
