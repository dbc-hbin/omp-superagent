use super::{
    addressing_tests::{parent, respond, start},
    *,
};

#[tokio::test]
async fn guild_work_thread_placement_preserves_ingress_and_exact_receipt_authority() {
    let temp = Temp::new();
    let store = Arc::new(Store::open(&temp.0).unwrap());
    let (hub, ws, mut observed, _, server, replies, state) = discord_fixture_with_store(
        json!({"discord":{
            "allowCrossChannelThreads":true, "crossChannelThreadScope":"guild"
        }}),
        &store,
    )
    .await;
    let mut socket = start(&hub, &ws, false).await;
    let source = parent();
    let mut target = source.clone();
    target["channelId"] = json!("89");
    let opened = json!({"id":"91","type":11,"parent_id":"89","guild_id":"77","name":"Work",
        "thread_metadata":{"archived":false}});
    let mut thread = target.clone();
    thread["threadId"] = json!("91");
    let set = |path: &str, data: Value| respond(&replies, path, StatusCode::OK, data);
    set(
        "/channels/89",
        json!({"id":"89","type":0,"guild_id":"77","name":"Work parent"}),
    );
    set("/channels/91", opened.clone());
    set(
        "/channels/91/messages",
        json!({"id":"502","guild_id":"77","channel_id":"91","author":{"id":"71","bot":true}}),
    );
    set("/guilds/77", json!({"id":"77","owner_id":"42"}));
    set(
        "/guilds/77/members/71",
        json!({"user":{"id":"71","bot":true},"roles":[]}),
    );
    let permissions = permissions::VIEW_CHANNEL
        | permissions::SEND_MESSAGES
        | permissions::SEND_IN_THREADS
        | permissions::READ_HISTORY
        | permissions::CREATE_PUBLIC_THREADS;
    let roles = |bits: u64| {
        set(
            "/guilds/77/roles",
            json!([{"id":"77","permissions":bits.to_string()}]),
        )
    };
    roles(permissions);
    let can = [target.clone(), Value::Null, source.clone()];
    let create = [
        target.clone(),
        json!("Work"),
        Value::Null,
        Value::Null,
        source.clone(),
    ];
    assert_eq!(hub.effect("canCreateThread", &can).await.unwrap(), true);
    roles(permissions & !permissions::CREATE_PUBLIC_THREADS);
    assert_eq!(
        hub.effect("createThread", &create)
            .await
            .unwrap_err()
            .certainty,
        "rejected"
    );
    roles(permissions);
    set(
        "/channels/89",
        json!({"id":"89","type":0,"guild_id":"78","name":"Other guild"}),
    );
    assert!(hub.effect("createThread", &create).await.is_err());
    set(
        "/channels/89",
        json!({"id":"89","type":15,"guild_id":"77","name":"Work forum","flags":16,
        "available_tags":[{"id":"601","name":"Work","moderated":false}]}),
    );
    let info = hub
        .effect("inspectThread", &[target.clone(), source.clone()])
        .await
        .unwrap();
    assert_eq!(info["requiresTag"], true);
    assert_eq!(info["availableTags"][0]["id"], "601");
    assert!(hub.effect("createThread", &create).await.is_err());
    let mut tagged = create;
    tagged[3] = json!(["601"]);
    let mut wrong_parent = opened.clone();
    wrong_parent["id"] = json!("93");
    wrong_parent["parent_id"] = json!("88");
    set("/channels/89/threads", wrong_parent);
    assert_eq!(
        hub.effect("createThread", &tagged)
            .await
            .unwrap_err()
            .certainty,
        "uncertain"
    );
    received(&mut observed, "/channels/89/threads").await;
    set("/channels/89/threads", opened);
    assert_eq!(hub.effect("createThread", &tagged).await.unwrap(), thread);
    received(&mut observed, "/channels/89/threads").await;
    received(&mut observed, "/channels/91/thread-members/42").await;
    settled(&state).await;
    assert!(
        observed.try_recv().is_err(),
        "only the confirmed thread may get one owner membership write"
    );
    let output = json!({"id":"guild-output","route":thread,"text":"Work finished"});
    assert!(
        hub.effect("send", std::slice::from_ref(&output))
            .await
            .is_err()
    );
    // The controller stores this binding only after an exact native creation receipt.
    store
        .set_meta(
            "discord:work-thread:91",
            &json!({"source":source,"route":thread}).to_string(),
        )
        .unwrap();
    assert_eq!(
        hub.effect("send", std::slice::from_ref(&output))
            .await
            .unwrap(),
        "502"
    );
    assert_eq!(
        hub.effect("inspectThread", std::slice::from_ref(&thread))
            .await
            .unwrap()["title"],
        "Work"
    );
    assert!(
        hub.effect("assertRoute", std::slice::from_ref(&thread))
            .await
            .is_err()
    );
    assert!(
        hub.effect("fetchAfter", &[thread.clone(), json!("501")])
            .await
            .is_err()
    );
    assert!(
        hub.effect(
            "send",
            &[json!({"id":"parent-output","route":target,"text":"Not a thread"})]
        )
        .await
        .is_err()
    );

    dispatch(
        &mut socket,
        3,
        "MESSAGE_CREATE",
        message("181", Some("77"), "91", "42", "ordinary incoming"),
    )
    .await;
    dispatch(
        &mut socket,
        4,
        "MESSAGE_CREATE",
        message("182", Some("77"), "88", "42", "from allowed chat"),
    )
    .await;
    assert_eq!(event(&hub, &store).await["input"]["messageId"], "182");
    hub.stop().await.unwrap();
    server.abort();

    for config in [
        json!({"allowCrossChannelThreads":true}),
        json!({"crossChannelThreadScope":"guild"}),
    ] {
        let (hub, ws, _observed, _, server, _, _) =
            discord_fixture_with_store(json!({"discord":config}), &store).await;
        let _socket = start(&hub, &ws, false).await;
        assert!(
            hub.effect("send", std::slice::from_ref(&output))
                .await
                .is_err()
        );
        assert!(hub.effect("canCreateThread", &can).await.is_err());
        hub.stop().await.unwrap();
        server.abort();
    }
}
