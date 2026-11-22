use super::*;
use crate::server::tests::{GatewayClient, LifecycleFixture};
use rusqlite::{Connection, params};
use uuid::Uuid;

pub(super) async fn login(listener: &TcpListener) -> (FixtureSocket, Value) {
    let (stream, _) = listener.accept().await.unwrap();
    let mut socket = accept_async(stream).await.unwrap();
    wire(&mut socket, json!({"op":10,"d":{"heartbeat_interval":60_000}})).await;
    let packet = packet(&mut socket).await;
    (socket, packet)
}

pub(super) async fn packet(socket: &mut FixtureSocket) -> Value {
    let next = time::timeout(Duration::from_secs(9), socket.next()).await.unwrap();
    serde_json::from_str(next.unwrap().unwrap().to_text().unwrap()).unwrap()
}

pub(super) async fn start(hub: &Hub, listener: &TcpListener, account: &str) -> (FixtureSocket, Value) {
    let server = async {
        let (mut socket, identify) = login(listener).await;
        assert_eq!(identify["op"], 2);
        dispatch(&mut socket, 1, "READY", json!({
            "user":{"id":account,"bot":true},
            "application":{"id":"72"},"session_id":"test-session",
            "resume_gateway_url":format!("ws://{}/", listener.local_addr().unwrap())
        })).await;
        (socket, identify)
    };
    let (result, socket) = time::timeout(Duration::from_secs(5), async {
        tokio::join!(hub.start(), server)
    }).await.unwrap();
    result.unwrap();
    socket
}

pub(super) async fn presence_packet(socket: &mut FixtureSocket, status: &str) {
    loop {
        let sent = packet(socket).await;
        if sent["op"] == 1 {
            wire(socket, json!({"op":11,"d":null})).await;
        } else {
            assert_eq!(sent, json!({"op":3,"d":{
                "status":status,"since":null,"activities":[],"afk":false,
            }}));
            break;
        }
    }
}

pub(super) fn head(root: &SocketDir) -> Connection {
    let db = Connection::open(root.0.join("coordination.sqlite")).unwrap();
    db.execute_batch(
        "CREATE TABLE inputs (sequence INTEGER PRIMARY KEY AUTOINCREMENT,
           id TEXT NOT NULL UNIQUE, data TEXT NOT NULL, state TEXT NOT NULL);",
    ).unwrap();
    db
}

pub(super) struct Controller {
    client: GatewayClient,
    events: reqwest::Response,
}

pub(super) struct Input {
    sequence: Value,
    pub source: Value,
}

impl Controller {
    pub(super) async fn attach(root: &SocketDir, store: &Arc<Store>, hub: &Arc<Hub>) -> Self {
        let client = GatewayClient::with_adapters(
            root, store.clone(), Arc::new(LifecycleFixture), hub.clone(),
        ).await.unwrap();
        let events = client.events(root).await.unwrap();
        assert_eq!(client.call("/ready", &json!({})).await.unwrap()["ok"], true);
        Self { client, events }
    }

    async fn next(&mut self) -> Value {
        time::timeout(Duration::from_secs(5), async {
            let mut line = Vec::new();
            while let Some(chunk) = self.events.chunk().await.unwrap() {
                line.extend_from_slice(&chunk);
                if line.ends_with(b"\n") {
                    return serde_json::from_slice(&line).unwrap();
                }
            }
            panic!("Gateway events closed before delivering the next frame");
        }).await.expect("Gateway did not deliver the next event")
    }

    async fn receipt(&self, sequence: &Value) {
        assert_eq!(self.client.call("/receipt", &json!({
            "sequence":sequence,"outcome":"accepted",
        })).await.unwrap()["ok"], true);
    }

    pub(super) async fn original(&mut self, socket: &mut FixtureSocket, sequence: u64, text: &str) -> Input {
        dispatch(socket, sequence, "MESSAGE_CREATE",
            message(&(sequence + 200).to_string(), None, "99", "42", text)).await;
        let input = self.next_input().await;
        assert_eq!(input.source["text"], text);
        assert_eq!(input.source["route"]["channelId"], "99");
        input
    }

    pub(super) async fn next_input(&mut self) -> Input {
        let mut frame = self.next().await;
        assert_eq!(frame["event"]["kind"], "message");
        let source = frame["event"]["input"].take();
        Input { sequence: frame["sequence"].take(), source }
    }

    pub(super) async fn admit(&self, db: &Connection, input: &Input) {
        persist(db, &input.source);
        self.receipt(&input.sequence).await;
    }

    pub(super) async fn reconnect(&mut self) {
        let frame = self.next().await;
        assert_eq!(frame["event"]["kind"], "reconnect");
        self.receipt(&frame["sequence"]).await;
    }

    pub(super) async fn close(self) {
        drop(self.events);
        self.client.server.close().await.unwrap();
    }
}

pub(super) fn persist(db: &Connection, source: &Value) {
    let id = source["id"].as_str().unwrap();
    let tx = db.unchecked_transaction().unwrap();
    tx.execute("INSERT INTO inputs (id,data,state) VALUES (?,?,'submitted')",
        params![id, source.to_string()]).unwrap();
    tx.execute("INSERT INTO metadata (key,value) VALUES (?,'true')",
        [format!("user-source:{id}")]).unwrap();
    tx.commit().unwrap();
}

pub(super) fn effect(action: &str, input: &Input) -> Value {
    request(action, &input.source)
}

pub(super) fn request(action: &str, source: &Value) -> Value {
    json!({"id":Uuid::new_v4().to_string(),"operation":"messengerPresence","args":[{
        "action":action,"sourceId":source["id"],"route":source["route"],
    }]})
}

pub(super) async fn call(controller: &Controller, effect: &Value) -> Value {
    controller.client.call("/effect", effect).await.unwrap()
}

pub(super) fn snapshot(desired: &str, connection: &str, last_sent: Option<&str>, replayed: bool) -> Value {
    json!({"ok":true,"value":{
        "platform":"discord","desired":desired,"connection":connection,
        "lastSent":last_sent,"replayed":replayed,
    }})
}
