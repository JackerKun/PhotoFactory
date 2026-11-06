# PhotoFactory 功能增强实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 统一相册浏览体验、优化 People 人脸展示、建立标签自动打标规则引擎（阶段 1）

**Architecture:** 前端抽取共享 PhotoGridView 组件给 SmartAlbumView 复用；后端新增规则引擎模块在 AI pipeline 后自动打标；数据库添加 tag_type 列支持分类查询

**Tech Stack:** React + TypeScript (前端), Rust + SQLite (后端), image crate (色调分析), reqwest (天气 API)

---

### Task 1: 数据库迁移 — 添加 tag_type 列

**Files:**
- Modify: `src-tauri/src/db/schema.rs` — 添加迁移逻辑
- Modify: `src-tauri/src/db/connection.rs` — 启动时执行迁移
- Modify: `src-tauri/Cargo.toml` — 确认已有 image crate 依赖

- [ ] **Step 1: 检查并修改 schema.rs 添加迁移**

在 `schema.rs` 末尾添加迁移常量：

```rust
/// Migration: add tag_type column to ai_classifications if it doesn't exist.
pub const MIGRATION_ADD_TAG_TYPE: &str = r#"
-- Add tag_type column to ai_classifications (idempotent via ALTER TABLE)
-- SQLite doesn't support IF NOT EXISTS for columns, so we use a workaround
"#;
```

实际上 SQLite 的 `ALTER TABLE ADD COLUMN` 在列已存在时会报错，所以我们需要在 Rust 侧检查列是否存在：

```rust
pub fn ensure_tag_type_column(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    // Check if column exists
    let has_column: bool = conn.query_row(
        "SELECT COUNT(*) > 0 FROM pragma_table_info('ai_classifications') WHERE name='tag_type'",
        [],
        |r| r.get(0),
    )?;
    if !has_column {
        conn.execute(
            "ALTER TABLE ai_classifications ADD COLUMN tag_type TEXT DEFAULT 'ai_scene'",
            [],
        )?;
    }
    Ok(())
}
```

在 `schema.rs` 末尾添加：

```rust
/// Ensure tag_type column exists in ai_classifications (idempotent).
pub fn ensure_tag_type_column(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    let has_column: bool = conn.query_row(
        "SELECT COUNT(*) > 0 FROM pragma_table_info('ai_classifications') WHERE name='tag_type'",
        [],
        |r| r.get(0),
    )?;
    if !has_column {
        conn.execute(
            "ALTER TABLE ai_classifications ADD COLUMN tag_type TEXT DEFAULT 'ai_scene'",
            [],
        )?;
    }
    Ok(())
}
```

- [ ] **Step 2: 在数据库初始化时调用迁移**

读取 `src-tauri/src/db/connection.rs`，找到 `init_db` 函数，在创建表之后调用 `ensure_tag_type_column`。

```rust
// 在 init_db 函数中，CREATE_TABLES 执行之后：
ensure_tag_type_column(&conn)?;
```

- [ ] **Step 3: 验证编译通过**

```bash
cd src-tauri && cargo check
```

Expected: 编译成功，无错误

- [ ] **Step 4: 提交**

```bash
git add src-tauri/src/db/schema.rs src-tauri/src/db/connection.rs
git commit -m "feat: add tag_type column migration to ai_classifications"
```

---

### Task 2: Places365 中文翻译映射

**Files:**
- Create: `src-tauri/src/tags/mod.rs` — 新模块入口
- Create: `src-tauri/src/tags/places365_cn.rs` — 365 个英文→中文映射
- Modify: `src-tauri/src/commands/tags.rs` — 在 get_all_labels 和 get_label_hierarchy 中添加翻译
- Modify: `src-tauri/src/lib.rs` — 添加 tags 模块声明
- Modify: `src-tauri/src/main.rs` — 注册 tags 模块的新命令

- [ ] **Step 1: 创建 tags/mod.rs**

```rust
// src-tauri/src/tags/mod.rs
pub mod places365_cn;
pub mod face_tagger;
pub mod time_tagger;
pub mod weather_tagger;
pub mod tone_tagger;
```

- [ ] **Step 2: 创建 places365_cn.rs 映射表**

```rust
// src-tauri/src/tags/places365_cn.rs
use std::collections::HashMap;
use once_cell::sync::Lazy;

static PLACES365_CN: Lazy<HashMap<&str, &str>> = Lazy::new(|| {
    let mut m = HashMap::new();
    // A
    m.insert("a_airfield", "机场跑道");
    m.insert("a_airplane_cabin", "飞机客舱");
    m.insert("a_airport_terminal", "机场航站楼");
    m.insert("a_alcove", "壁龛");
    m.insert("a_alley", "小巷");
    m.insert("a_amphitheater", "圆形剧场");
    m.insert("a_amusement_arcade", "游戏厅");
    m.insert("a_amusement_park", "游乐园");
    m.insert("a_apartment_building_outdoor", "公寓楼外景");
    m.insert("a_aquarium", "水族馆");
    m.insert("a_aqueduct", "渡槽");
    m.insert("a_arcade", "拱廊");
    m.insert("a_arch", "拱门");
    m.insert("a_archaelogical_excavation", "考古发掘现场");
    m.insert("a_archive", "档案馆");
    m.insert("a_arena_hockey", "曲棍球场");
    m.insert("a_arena_performance", "表演场馆");
    m.insert("a_arena_rodeo", "牛仔竞技场");
    m.insert("a_army_base", "军事基地");
    m.insert("a_art_gallery", "美术馆");
    m.insert("a_art_school", "艺术学校");
    m.insert("a_art_studio", "艺术工作室");
    m.insert("a_artists_loft", "艺术家阁楼");
    m.insert("a_assembly_line", "装配线");
    m.insert("a_athletic_field_outdoor", "户外运动场");
    m.insert("a_atrium_public", "公共中庭");
    m.insert("a_attic", "阁楼");
    m.insert("a_auditorium", "礼堂");
    m.insert("a_auto_factory", "汽车工厂");
    m.insert("a_auto_showroom", "汽车展厅");
    // B
    m.insert("b_badlands", "荒地");
    m.insert("b_bakery_shop", "面包店");
    m.insert("b_balcony_exterior", "阳台外景");
    m.insert("b_balcony_interior", "阳台内景");
    m.insert("b_ball_pit", "球池");
    m.insert("b_ballroom", "宴会厅");
    m.insert("b_bamboo_forest", "竹林");
    m.insert("b_bank_vault", "银行金库");
    m.insert("b_banquet_hall", "宴会厅");
    m.insert("b_bar", "酒吧");
    m.insert("b_barn", "谷仓");
    m.insert("b_barndoor", "谷仓门");
    m.insert("b_baseball_field", "棒球场");
    m.insert("b_basement", "地下室");
    m.insert("b_basketball_court_indoor", "室内篮球场");
    m.insert("b_bathroom", "浴室");
    m.insert("b_bazaar_indoor", "室内集市");
    m.insert("b_bazaar_outdoor", "室外集市");
    m.insert("b_beach", "海滩");
    m.insert("b_beach_house", "海滨小屋");
    m.insert("b_beauty_salon", "美容院");
    m.insert("b_bedchamber", "卧室");
    m.insert("b_bedroom", "卧室");
    m.insert("b_beer_garden", "啤酒花园");
    m.insert("b_beer_hall", "啤酒大厅");
    m.insert("b_berth", "卧铺");
    m.insert("b_biology_laboratory", "生物实验室");
    m.insert("b_boardwalk", "木板路");
    m.insert("b_boat_deck", "船甲板");
    m.insert("b_boathouse", "船库");
    m.insert("b_bookstore", "书店");
    m.insert("b_booth_indoor", "室内摊位");
    m.insert("b_botanical_garden", "植物园");
    m.insert("b_bow_window_indoor", "室内飘窗");
    m.insert("b_bowling_alley", "保龄球馆");
    m.insert("b_boxing_ring", "拳击台");
    m.insert("b_bridge", "桥");
    m.insert("b_building_facade", "建筑外立面");
    m.insert("b_bullring", "斗牛场");
    m.insert("b_burial_chamber", "墓室");
    m.insert("b_bus_interior", "公交车内");
    m.insert("b_bus_station_indoor", "室内公交车站");
    m.insert("b_butchers_shop", "肉店");
    m.insert("b_butte", "孤山");
    // C
    m.insert("c_cabin_outdoor", "户外小屋");
    m.insert("c_cafeteria", "自助餐厅");
    m.insert("c_campsite", "露营地");
    m.insert("c_campus", "校园");
    m.insert("c_canal_natural", "自然运河");
    m.insert("c_canal_urban", "城市运河");
    m.insert("c_candy_store", "糖果店");
    m.insert("c_canyon", "峡谷");
    m.insert("c_car_interior", "汽车内部");
    m.insert("c_carrousel", "旋转木马");
    m.insert("c_castle", "城堡");
    m.insert("c_catacomb", "地下墓穴");
    m.insert("c_cemetery", "墓地");
    m.insert("c_chalet", "木屋");
    m.insert("c_chemistry_lab", "化学实验室");
    m.insert("c_childs_room", "儿童房");
    m.insert("c_church_indoor", "教堂内部");
    m.insert("c_church_outdoor", "教堂外部");
    m.insert("c_classroom", "教室");
    m.insert("c_clean_room", "无尘室");
    m.insert("c_cliff", "悬崖");
    m.insert("c_closet", "衣柜");
    m.insert("c_clothing_store", "服装店");
    m.insert("c_coast", "海岸");
    m.insert("c_cockpit", "驾驶舱");
    m.insert("c_coffee_shop", "咖啡店");
    m.insert("c_computer_room", "计算机房");
    m.insert("c_conference_center", "会议中心");
    m.insert("c_conference_room", "会议室");
    m.insert("c_construction_site", "建筑工地");
    m.insert("c_corn_field", "玉米田");
    m.insert("c_corral", "畜栏");
    m.insert("c_corridor", "走廊");
    m.insert("c_cottage", "村舍");
    m.insert("c_courthouse", "法院");
    m.insert("c_courtyard", "庭院");
    m.insert("c_creek", "溪流");
    m.insert("c_crevasse", "冰隙");
    m.insert("c_crosswalk", "人行横道");
    // D
    m.insert("d_dam", "大坝");
    m.insert("d_delicatessen", "熟食店");
    m.insert("d_department_store", "百货公司");
    m.insert("d_desert_sand", "沙漠");
    m.insert("d_desert_vegetation", "沙漠植被");
    m.insert("d_desert_road", "沙漠公路");
    m.insert("d_diner_outdoor", "室外餐厅");
    m.insert("d_dining_hall", "餐厅大厅");
    m.insert("d_dining_room", "餐厅");
    m.insert("d_discotheque", "迪斯科舞厅");
    m.insert("d_doorway_outdoor", "室外门口");
    m.insert("d_dorm_room", "宿舍房间");
    m.insert("d_downtown", "市中心");
    m.insert("d_dressing_room", "更衣室");
    m.insert("d_driveway", "车道");
    m.insert("d_drugstore", "药店");
    // E
    m.insert("e_elevator_door", "电梯门");
    m.insert("e_elevator_lobby", "电梯大堂");
    m.insert("e_elevator_shaft", "电梯井");
    m.insert("e_embassy", "大使馆");
    m.insert("e_engine_room", "机房");
    m.insert("e_entrance_hall", "入口大厅");
    m.insert("e_escalator_indoor", "室内自动扶梯");
    m.insert("e_excavation", "挖掘现场");
    // F
    m.insert("f_fabric_store", "布料店");
    m.insert("f_farm", "农场");
    m.insert("f_fastfood_restaurant", "快餐店");
    m.insert("f_field_cultivated", "农田");
    m.insert("f_field_wild", "野外");
    m.insert("f_field_road", "田间小路");
    m.insert("f_fire_escape", "消防通道");
    m.insert("f_fire_station", "消防站");
    m.insert("f_fishpond", "鱼塘");
    m.insert("f_flea_market_indoor", "室内跳蚤市场");
    m.insert("f_florist_shop_indoor", "室内花店");
    m.insert("f_food_court", "美食广场");
    m.insert("f_football_field", "足球场");
    m.insert("f_forest_broadleaf", "阔叶林");
    m.insert("f_forest_path", "林间小路");
    m.insert("f_forest_road", "林间公路");
    m.insert("f_formal_garden", "正式花园");
    m.insert("f_fountain", "喷泉");
    // G
    m.insert("g_galley", "船舱厨房");
    m.insert("g_garage_indoor", "室内车库");
    m.insert("g_garage_outdoor", "室外车库");
    m.insert("g_gas_station", "加油站");
    m.insert("g_gazebo_exterior", "室外凉亭");
    m.insert("g_general_store_indoor", "室内杂货店");
    m.insert("g_general_store_outdoor", "室外杂货店");
    m.insert("g_gift_shop", "礼品店");
    m.insert("g_glacier", "冰川");
    m.insert("g_golf_course", "高尔夫球场");
    m.insert("g_greenhouse_indoor", "室内温室");
    m.insert("g_greenhouse_outdoor", "室外温室");
    m.insert("g_grotto", "洞穴");
    m.insert("g_gymnasium_indoor", "室内体育馆");
    // H
    m.insert("h_hangar_indoor", "室内机库");
    m.insert("h_hangar_outdoor", "室外机库");
    m.insert("h_harbor", "港口");
    m.insert("h_hardware_store", "五金店");
    m.insert("h_hayfield", "干草田");
    m.insert("h_heliport", "直升机停机坪");
    m.insert("h_highway", "高速公路");
    m.insert("h_home_office", "家庭办公室");
    m.insert("h_home_theater", "家庭影院");
    m.insert("h_hospital", "医院");
    m.insert("h_hospital_room", "病房");
    m.insert("h_hot_spring", "温泉");
    m.insert("h_hotel_outdoor", "酒店外景");
    m.insert("h_hotel_room", "酒店房间");
    m.insert("h_house", "房屋");
    m.insert("h_hunting_lodge_outdoor", "狩猎小屋");
    // I
    m.insert("i_ice_cream_parlor", "冰淇淋店");
    m.insert("i_ice_floe", "浮冰");
    m.insert("i_ice_shelf", "冰架");
    m.insert("i_ice_skating_rink_indoor", "室内溜冰场");
    m.insert("i_ice_skating_rink_outdoor", "室外溜冰场");
    m.insert("i_iceberg", "冰山");
    m.insert("i_igloo", "冰屋");
    m.insert("i_industrial_area", "工业区");
    m.insert("i_inn_outdoor", "旅馆外景");
    m.insert("i_islet", "小岛");
    // J
    m.insert("j_jacuzzi_indoor", "室内按摩浴缸");
    m.insert("j_jail_cell", "牢房");
    m.insert("j_japanese_garden", "日式花园");
    m.insert("j_jewelry_shop", "珠宝店");
    m.insert("j_junkyard", "垃圾场");
    // K
    m.insert("k_kasbah", "城堡");
    m.insert("k_kennel_outdoor", "室外狗舍");
    m.insert("k_kindergarden_classroom", "幼儿园教室");
    m.insert("k_kitchen", "厨房");
    // L
    m.insert("l_lagoon", "泻湖");
    m.insert("l_lake_natural", "天然湖泊");
    m.insert("l_landfill", "垃圾填埋场");
    m.insert("l_landing_deck", "登陆甲板");
    m.insert("l_laundromat", "自助洗衣店");
    m.insert("l_lawn", "草坪");
    m.insert("l_lecture_room", "讲堂");
    m.insert("l_legislative_chamber", "立法会议厅");
    m.insert("l_library_indoor", "室内图书馆");
    m.insert("l_library_outdoor", "室外图书馆");
    m.insert("l_lighthouse", "灯塔");
    m.insert("l_living_room", "客厅");
    m.insert("l_loading_dock", "装卸码头");
    m.insert("l_lobby", "大厅");
    m.insert("l_lock_chamber", "锁室");
    m.insert("l_locker_room", "更衣室");
    // M
    m.insert("m_mansion", "豪宅");
    m.insert("m_manufactured_home", "预制房屋");
    m.insert("m_market_indoor", "室内市场");
    m.insert("m_market_outdoor", "室外市场");
    m.insert("m_marsh", "沼泽");
    m.insert("m_martial_arts_gym", "武术馆");
    m.insert("m_mausoleum", "陵墓");
    m.insert("m_medina", "麦地那");
    m.insert("m_mezzanine", "夹层");
    m.insert("m_moat_water", "护城河");
    m.insert("m_mosque_outdoor", "清真寺外景");
    m.insert("m_motel", "汽车旅馆");
    m.insert("m_mountain", "山");
    m.insert("m_mountain_path", "山路");
    m.insert("m_mountain_snowy", "雪山");
    m.insert("m_movie_theater_indoor", "室内电影院");
    m.insert("m_museum_indoor", "室内博物馆");
    m.insert("m_museum_outdoor", "室外博物馆");
    m.insert("m_music_studio", "音乐工作室");
    // N
    m.insert("n_natural_history_museum", "自然历史博物馆");
    m.insert("n_nursery", "托儿所");
    m.insert("n_nursing_home", "养老院");
    // O
    m.insert("o_oast_house", "啤酒花干燥室");
    m.insert("o_ocean", "海洋");
    m.insert("o_office", "办公室");
    m.insert("o_office_building", "办公楼");
    m.insert("o_office_cubicles", "办公隔间");
    m.insert("o_oilrig", "石油钻井平台");
    m.insert("o_operating_room", "手术室");
    m.insert("o_orchard", "果园");
    m.insert("o_orchestra_pit", "乐池");
    // P
    m.insert("p_pagoda", "宝塔");
    m.insert("p_palace", "宫殿");
    m.insert("p_pantry", "储藏室");
    m.insert("p_park", "公园");
    m.insert("p_parking_garage_indoor", "室内停车场");
    m.insert("p_parking_garage_outdoor", "室外停车场");
    m.insert("p_parking_lot", "停车场");
    m.insert("p_pasture", "牧场");
    m.insert("p_patio", "露台");
    m.insert("p_pavilion", "亭子");
    m.insert("p_pet_shop", "宠物店");
    m.insert("p_pharmacy", "药店");
    m.insert("p_phone_booth", "电话亭");
    m.insert("p_physics_laboratory", "物理实验室");
    m.insert("p_picnic_area", "野餐区");
    m.insert("p_pier", "码头");
    m.insert("p_pizzeria", "披萨店");
    m.insert("p_playground", "游乐场");
    m.insert("p_playroom", "游戏室");
    m.insert("p_plaza", "广场");
    m.insert("p_pond", "池塘");
    m.insert("p_porch", "门廊");
    m.insert("p_promenade", "散步道");
    m.insert("p_pub_indoor", "室内酒吧");
    // R
    m.insert("r_racecourse", "赛马场");
    m.insert("r_raceway", "赛道");
    m.insert("r_raft", "木筏");
    m.insert("r_railroad_track", "铁轨");
    m.insert("r_rainforest", "热带雨林");
    m.insert("r_reception", "接待处");
    m.insert("r_recreation_room", "娱乐室");
    m.insert("r_repair_shop", "修理店");
    m.insert("r_residential_neighborhood", "住宅区");
    m.insert("r_restaurant", "餐厅");
    m.insert("r_restaurant_kitchen", "餐厅厨房");
    m.insert("r_restaurant_patio", "餐厅露台");
    m.insert("r_rice_paddy", "稻田");
    m.insert("r_river", "河流");
    m.insert("r_rock_arch", "岩石拱门");
    m.insert("r_roof_garden", "屋顶花园");
    m.insert("r_rope_bridge", "索桥");
    m.insert("r_ruin", "废墟");
    m.insert("r_runway", "跑道");
    // S
    m.insert("s_sandbox", "沙箱");
    m.insert("s_sauna", "桑拿");
    m.insert("s_schoolhouse", "校舍");
    m.insert("s_science_museum", "科学博物馆");
    m.insert("s_server_room", "服务器机房");
    m.insert("s_shed", "棚屋");
    m.insert("s_shoe_shop", "鞋店");
    m.insert("s_shopfront", "店面");
    m.insert("s_shopping_mall_indoor", "室内购物中心");
    m.insert("s_shower", "淋浴");
    m.insert("s_ski_resort", "滑雪胜地");
    m.insert("s_ski_slope", "滑雪坡道");
    m.insert("s_sky", "天空");
    m.insert("s_skyscraper", "摩天大楼");
    m.insert("s_slum", "贫民窟");
    m.insert("s_snowfield", "雪地");
    m.insert("s_soccer_field", "足球场");
    m.insert("s_stable", "马厩");
    m.insert("s_stadium_baseball", "棒球场");
    m.insert("s_stadium_football", "美式足球场");
    m.insert("s_stadium_soccer", "足球场");
    m.insert("s_stage_indoor", "室内舞台");
    m.insert("s_stage_outdoor", "室外舞台");
    m.insert("s_staircase", "楼梯");
    m.insert("s_storage_room", "储藏室");
    m.insert("s_street", "街道");
    m.insert("s_subway_station_platform", "地铁站台");
    m.insert("s_supermarket", "超市");
    m.insert("s_sushi_bar", "寿司店");
    m.insert("s_swamp", "沼泽");
    m.insert("s_swimming_hole", "游泳洞");
    m.insert("s_swimming_pool_indoor", "室内游泳池");
    m.insert("s_swimming_pool_outdoor", "室外游泳池");
    m.insert("s_synagogue_outdoor", "犹太教堂外景");
    // T
    m.insert("t_television_room", "电视室");
    m.insert("t_television_studio", "电视演播室");
    m.insert("t_temple_asia", "亚洲寺庙");
    m.insert("t_throne_room", "宝座厅");
    m.insert("t_ticket_booth", "售票亭");
    m.insert("t_topiary_garden", "修剪花园");
    m.insert("t_tower", "塔");
    m.insert("t_toyshop", "玩具店");
    m.insert("t_train_interior", "火车内部");
    m.insert("t_train_station_platform", "火车站台");
    m.insert("t_tree_farm", "树苗农场");
    m.insert("t_tree_house", "树屋");
    m.insert("t_trench", "战壕");
    m.insert("t_tundra", "苔原");
    // U
    m.insert("u_underwater_ocean_deep", "深海");
    m.insert("u_utility_room", "杂物间");
    // V
    m.insert("v_valley", "山谷");
    m.insert("v_vegetable_garden", "菜园");
    m.insert("v_veterinarians_office", "兽医诊所");
    m.insert("v_viaduct", "高架桥");
    m.insert("v_village", "村庄");
    m.insert("v_vineyard", "葡萄园");
    m.insert("v_volcano", "火山");
    m.insert("v_volleyball_court_outdoor", "室外排球场");
    // W
    m.insert("w_waiting_room", "候车室");
    m.insert("w_water_park", "水上乐园");
    m.insert("w_water_tower", "水塔");
    m.insert("w_waterfall", "瀑布");
    m.insert("w_watering_hole", "水坑");
    m.insert("w_wave", "海浪");
    m.insert("w_wet_bar", "湿吧台");
    m.insert("w_wheat_field", "麦田");
    m.insert("w_wind_farm", "风力发电场");
    m.insert("w_windmill", "风车");
    // Y
    m.insert("y_yard", "院子");
    m.insert("y_youth_hostel", "青年旅社");
    // Z
    m.insert("z_zen_garden", "禅意花园");

    m
});

/// Translate a Places365 English label to Chinese.
/// Returns the original label if no translation is found.
pub fn translate_label(label: &str) -> &str {
    PLACES365_CN.get(label).copied().unwrap_or(label)
}

/// Translate a label that may or may not be a Places365 label.
/// Only translates if the label starts with a known Places365 prefix pattern.
pub fn translate_if_places365(label: &str) -> &str {
    translate_label(label)
}
```

- [ ] **Step 3: 在 tags.rs 命令中添加翻译**

修改 `src-tauri/src/commands/tags.rs`：

在 `cmd_get_all_labels` 中，返回翻译后的标签：

```rust
pub async fn cmd_get_all_labels(state: State<'_, AppState>) -> AppResult<Vec<(String, i64)>> {
    let conn = get_conn(state)?;
    let raw = classification_dao::get_all_labels(&conn)?;
    // Translate Places365 labels to Chinese
    Ok(raw.into_iter().map(|(label, count)| {
        (crate::tags::places365_cn::translate_if_places365(&label).to_string(), count)
    }).collect())
}
```

同样修改 `cmd_get_label_hierarchy`：

```rust
pub async fn cmd_get_label_hierarchy(state: State<'_, AppState>) -> AppResult<Vec<classification_dao::LabelNode>> {
    let conn = get_conn(state)?;
    let nodes = classification_dao::get_label_hierarchy(&conn)?;
    // Translate Places365 labels in the hierarchy
    Ok(nodes.into_iter().map(|mut node| {
        node.label = crate::tags::places365_cn::translate_if_places365(&node.label).to_string();
        node
    }).collect())
}
```

- [ ] **Step 4: 在 lib.rs 添加 tags 模块**

```rust
// src-tauri/src/lib.rs 顶部添加：
pub mod tags;
```

- [ ] **Step 5: 验证编译**

```bash
cd src-tauri && cargo check
```

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/tags/mod.rs src-tauri/src/tags/places365_cn.rs src-tauri/src/commands/tags.rs src-tauri/src/lib.rs src-tauri/src/db/schema.rs
git commit -m "feat: add Places365 Chinese translation mapping"
```

---

### Task 3: 规则引擎入口 + 人脸数量标签

**Files:**
- Create: `src-tauri/src/commands/tag_rules.rs` — 规则引擎命令入口
- Create: `src-tauri/src/tags/face_tagger.rs` — 人脸数量规则标签
- Modify: `src-tauri/src/tags/mod.rs` — 添加 face_tagger 和 tag_rules 引用
- Modify: `src-tauri/src/main.rs` — 注册 tag_rules 命令
- Modify: `src-tauri/src/commands/ai.rs` — 在 auto-pipeline 中调用规则引擎

- [ ] **Step 1: 创建 face_tagger.rs**

```rust
// src-tauri/src/tags/face_tagger.rs
use rusqlite::Connection;

use crate::db::classification_dao::insert_classification_with_type;
use crate::error::{AppError, AppResult};
use crate::models::AiClassification;

/// Run face-count based tagging on photos that have face detections but no face_count tag.
///
/// Rules:
/// - 1 face → "单人"
/// - 2 faces → "双人"
/// - >=3 faces → "合影"
pub fn run_face_tagging(conn: &Connection, batch_size: usize) -> AppResult<usize> {
    // Find photos with face detections that haven't been face-count tagged
    let query = "
        SELECT fd.photo_id, COUNT(*) as face_count
        FROM face_detections fd
        JOIN photos p ON p.id = fd.photo_id
        WHERE p.deleted = 0
          AND fd.photo_id NOT IN (
              SELECT photo_id FROM ai_classifications WHERE tag_type = 'rule_face_count'
          )
        GROUP BY fd.photo_id
        LIMIT ?
    ";

    let mut stmt = conn.prepare(query).map_err(|e| {
        AppError::Internal(format!("Failed to prepare face count query: {}", e))
    })?;

    let rows: Vec<(i64, i64)> = stmt
        .query_map([batch_size as i64], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(|e| AppError::Internal(format!("Failed to query face counts: {}", e)))?
        .filter_map(|r| r.ok())
        .collect();

    let mut tagged = 0;
    for (photo_id, count) in rows {
        let label = match count {
            1 => "单人",
            2 => "双人",
            _ => "合影",
        };

        let classification = AiClassification {
            id: None,
            photo_id,
            category: "rule".into(),
            label: label.to_string(),
            confidence: 1.0,
        };
        if insert_classification_with_type(conn, &classification, "rule_face_count").is_ok() {
            tagged += 1;
        }
    }

    Ok(tagged)
}
```

- [ ] **Step 2: 创建 tag_rules.rs 命令**

```rust
// src-tauri/src/commands/tag_rules.rs
use tauri::State;

use crate::commands::project::{AppState, get_conn};
use crate::error::{AppError, AppResult};

/// Run all rule-based tagging on photos.
/// This includes face count, time period, season, weather, and tone tags.
#[tauri::command]
pub async fn cmd_run_tag_rules(
    state: State<'_, AppState>,
) -> AppResult<String> {
    let conn = get_conn(state.clone())?;
    let mut messages = Vec::new();

    // 1. Face count tags
    match crate::tags::face_tagger::run_face_tagging(&conn, 500) {
        Ok(count) => messages.push(format!("Face count tags: {} photos", count)),
        Err(e) => messages.push(format!("Face count tagging failed: {}", e)),
    }

    // 2. Time period tags
    match crate::tags::time_tagger::run_time_period_tagging(&conn, 500) {
        Ok(count) => messages.push(format!("Time period tags: {} photos", count)),
        Err(e) => messages.push(format!("Time period tagging failed: {}", e)),
    }

    // 3. Season tags
    match crate::tags::time_tagger::run_season_tagging(&conn, 500) {
        Ok(count) => messages.push(format!("Season tags: {} photos", count)),
        Err(e) => messages.push(format!("Season tagging failed: {}", e)),
    }

    // 4. Weather tags (requires GPS)
    match crate::tags::weather_tagger::run_weather_tagging(&conn, 100).await {
        Ok(count) => messages.push(format!("Weather tags: {} photos", count)),
        Err(e) => messages.push(format!("Weather tagging failed: {}", e)),
    }

    // 5. Tone tags
    match crate::tags::tone_tagger::run_tone_tagging(&conn, 500) {
        Ok(count) => messages.push(format!("Tone tags: {} photos", count)),
        Err(e) => messages.push(format!("Tone tagging failed: {}", e)),
    }

    Ok(messages.join("\n"))
}
```

- [ ] **Step 3: 更新 tags/mod.rs**

```rust
pub mod places365_cn;
pub mod face_tagger;
pub mod time_tagger;
pub mod weather_tagger;
pub mod tone_tagger;
```

- [ ] **Step 4: 在 main.rs 注册命令**

```rust
// 添加到 invoke_handler:
tag_rules::cmd_run_tag_rules,
```

同时添加 use:

```rust
use photofactory::commands::tag_rules;
```

- [ ] **Step 5: 在 auto-pipeline 中调用规则引擎**

修改 `src-tauri/src/commands/ai.rs` 的 `cmd_auto_ai_pipeline`，在事件标签之后添加：

```rust
// 9. Rule-based tagging (face count, time, season, weather, tone)
match cmd_run_tag_rules(state.clone()).await {
    Ok(msg) => messages.push(format!("Rule tags: {}", msg)),
    Err(e) => messages.push(format!("Rule tagging failed: {}", e)),
}
```

注意：`cmd_run_tag_rules` 是 async 函数，需要从 `tag_rules` 模块调用内部函数而非 Tauri command。所以我们改一下 tag_rules.rs，添加一个非 Tauri 的内部函数供 pipeline 调用。

实际上，直接 `tag_rules::cmd_run_tag_rules(state).await` 即可，因为 tauri::State 可以直接传入。

- [ ] **Step 6: 验证编译**

```bash
cd src-tauri && cargo check
```

- [ ] **Step 7: 提交**

```bash
git add src-tauri/src/tags/face_tagger.rs src-tauri/src/commands/tag_rules.rs src-tauri/src/tags/mod.rs src-tauri/src/main.rs src-tauri/src/commands/ai.rs
git commit -m "feat: add rule engine entry point and face count tagging"
```

---

### Task 4: 时间/季节规则标签

**Files:**
- Create: `src-tauri/src/tags/time_tagger.rs` — 新的时间/季节规则模块
- (注意：已存在 `src-tauri/src/time_tagger.rs` 是旧模块，新模块在 tags/ 下)

- [ ] **Step 1: 创建 time_tagger.rs（新规则版本）**

```rust
// src-tauri/src/tags/time_tagger.rs
use chrono::{DateTime, Local, Utc};
use rusqlite::Connection;

use crate::db::classification_dao::insert_classification_with_type;
use crate::error::{AppError, AppResult};
use crate::models::AiClassification;

/// Time period labels based on hour of day.
fn time_period_label(hour: u32) -> &'static str {
    match hour {
        5..=7 => "清晨",
        8..=10 => "上午",
        11..=13 => "午后",
        14..=16 => "下午",
        17..=18 => "傍晚",
        19..=20 => "黄昏",
        _ => "夜晚", // 21-4
    }
}

/// Season label based on month.
fn season_label(month: u32) -> &'static str {
    match month {
        3..=5 => "春天",
        6..=8 => "夏天",
        9..=11 => "秋天",
        _ => "冬天", // 12, 1, 2
    }
}

/// Run time period tagging based on hour of day.
/// Queries photos where taken_at IS NOT NULL and not yet tagged.
pub fn run_time_period_tagging(conn: &Connection, batch_size: usize) -> AppResult<usize> {
    let query = "
        SELECT id, taken_at FROM photos
        WHERE taken_at IS NOT NULL
          AND deleted = 0
          AND id NOT IN (
              SELECT photo_id FROM ai_classifications WHERE tag_type = 'rule_time_period'
          )
        LIMIT ?
    ";

    let mut stmt = conn.prepare(query).map_err(|e| {
        AppError::Internal(format!("Failed to prepare query: {}", e))
    })?;

    let rows: Vec<(i64, i64)> = stmt
        .query_map([batch_size as i64], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(|e| AppError::Internal(format!("Failed to query photos: {}", e)))?
        .filter_map(|r| r.ok())
        .collect();

    let mut tagged = 0;
    for (photo_id, timestamp) in rows {
        // Convert unix timestamp to local time
        let dt = DateTime::from_timestamp(timestamp, 0)
            .unwrap_or_else(|| DateTime::from_timestamp(0, 0).unwrap())
            .with_timezone(&Local);

        let label = time_period_label(dt.hour());
        let classification = AiClassification {
            id: None,
            photo_id,
            category: "rule".into(),
            label: label.to_string(),
            confidence: 1.0,
        };
        if insert_classification_with_type(conn, &classification, "rule_time_period").is_ok() {
            tagged += 1;
        }
    }

    Ok(tagged)
}

/// Run season tagging based on month.
pub fn run_season_tagging(conn: &Connection, batch_size: usize) -> AppResult<usize> {
    let query = "
        SELECT id, taken_at FROM photos
        WHERE taken_at IS NOT NULL
          AND deleted = 0
          AND id NOT IN (
              SELECT photo_id FROM ai_classifications WHERE tag_type = 'rule_season'
          )
        LIMIT ?
    ";

    let mut stmt = conn.prepare(query).map_err(|e| {
        AppError::Internal(format!("Failed to prepare query: {}", e))
    })?;

    let rows: Vec<(i64, i64)> = stmt
        .query_map([batch_size as i64], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(|e| AppError::Internal(format!("Failed to query photos: {}", e)))?
        .filter_map(|r| r.ok())
        .collect();

    let mut tagged = 0;
    for (photo_id, timestamp) in rows {
        let dt = DateTime::from_timestamp(timestamp, 0)
            .unwrap_or_else(|| DateTime::from_timestamp(0, 0).unwrap())
            .with_timezone(&Local);

        let label = season_label(dt.month());
        let classification = AiClassification {
            id: None,
            photo_id,
            category: "rule".into(),
            label: label.to_string(),
            confidence: 1.0,
        };
        if insert_classification_with_type(conn, &classification, "rule_season").is_ok() {
            tagged += 1;
        }
    }

    Ok(tagged)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_time_period_labels() {
        assert_eq!("清晨", time_period_label(6));
        assert_eq!("上午", time_period_label(9));
        assert_eq!("午后", time_period_label(12));
        assert_eq!("下午", time_period_label(15));
        assert_eq!("傍晚", time_period_label(17));
        assert_eq!("黄昏", time_period_label(19));
        assert_eq!("夜晚", time_period_label(23));
        assert_eq!("夜晚", time_period_label(3));
    }

    #[test]
    fn test_season_labels() {
        assert_eq!("春天", season_label(4));
        assert_eq!("夏天", season_label(7));
        assert_eq!("秋天", season_label(10));
        assert_eq!("冬天", season_label(1));
        assert_eq!("冬天", season_label(12));
    }
}
```

- [ ] **Step 2: 运行单元测试**

```bash
cd src-tauri && cargo test time_tagger --no-fail-fast
```

Expected: 2 tests pass

- [ ] **Step 3: 提交**

```bash
git add src-tauri/src/tags/time_tagger.rs
git commit -m "feat: add time period and season rule tagging"
```

---

### Task 5: 天气标签（Open-Meteo 免费 API）

**Files:**
- Create: `src-tauri/src/tags/weather_tagger.rs` — 天气标签模块

- [ ] **Step 1: 创建 weather_tagger.rs**

使用 Open-Meteo Historical Weather API（免费，无需 API key）：
`https://archive-api.open-meteo.com/v1/archive?latitude=X&longitude=Y&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&daily=weather_code,temperature_2m_max`

```rust
// src-tauri/src/tags/weather_tagger.rs
use chrono::{DateTime, Local, NaiveDate, Utc};
use rusqlite::Connection;
use std::collections::HashMap;
use std::sync::{Mutex, LazyLock};
use std::time::{Duration, Instant};

use crate::db::classification_dao::insert_classification_with_type;
use crate::error::{AppError, AppResult};
use crate::models::AiClassification;

/// WMO Weather code to Chinese label mapping.
fn weather_code_label(code: i64) -> &'static str {
    match code {
        0 => "晴天",
        1 => "晴天",
        2 => "多云",
        3 => "阴天",
        45 => "雾天",
        48 => "雾天",
        51..=57 => "毛毛雨",
        61..=67 => "雨天",
        71..=77 => "雪天",
        80..=82 => "雨天",
        85..=86 => "雪天",
        95..=99 => "雷雨天",
        _ => "阴天",
    }
}

/// Rate limiter for weather API (1 req/s to be polite).
static LAST_REQUEST: Mutex<Option<Instant>> = Mutex::new(None);

/// Cache: "YYYY-MM-DD,lat_rounded,lng_rounded" → weather label.
static WEATHER_CACHE: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn wait_for_rate_limit() {
    let mut guard = LAST_REQUEST.lock().unwrap();
    if let Some(last) = *guard {
        let elapsed = last.elapsed();
        if elapsed < Duration::from_secs(1) {
            std::thread::sleep(Duration::from_secs(1) - elapsed);
        }
    }
    *guard = Some(Instant::now());
}

/// Fetch weather data from Open-Meteo for a given date and location.
fn fetch_weather(lat: f64, lng: f64, date: NaiveDate) -> Result<String, String> {
    let cache_key = format!("{}_{:.2}_{:.2}", date, lat, lng);
    {
        let cache = WEATHER_CACHE.lock().unwrap();
        if let Some(label) = cache.get(&cache_key) {
            return Ok(label.clone());
        }
    }

    wait_for_rate_limit();

    let url = format!(
        "https://archive-api.open-meteo.com/v1/archive?latitude={}&longitude={}&start_date={}&end_date={}&daily=weather_code",
        lat, lng, date, date
    );

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client.get(&url).send().map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("API returned {}", response.status()));
    }

    let json: serde_json::Value = response.json().map_err(|e| e.to_string())?;

    // Parse daily.weather_code[0]
    let code = json["daily"]["weather_code"][0]
        .as_i64()
        .ok_or("Failed to parse weather_code")?;

    let label = weather_code_label(code).to_string();

    {
        let mut cache = WEATHER_CACHE.lock().unwrap();
        cache.insert(cache_key, label.clone());
    }

    Ok(label)
}

/// Run weather tagging on photos with GPS coordinates.
pub async fn run_weather_tagging(conn: &Connection, batch_size: usize) -> AppResult<usize> {
    let query = "
        SELECT id, latitude, longitude, taken_at FROM photos
        WHERE latitude IS NOT NULL
          AND longitude IS NOT NULL
          AND taken_at IS NOT NULL
          AND deleted = 0
          AND id NOT IN (
              SELECT photo_id FROM ai_classifications WHERE tag_type = 'rule_weather'
          )
        LIMIT ?
    ";

    let mut stmt = conn.prepare(query).map_err(|e| {
        AppError::Internal(format!("Failed to prepare query: {}", e))
    })?;

    let rows: Vec<(i64, f64, f64, i64)> = stmt
        .query_map([batch_size as i64], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map_err(|e| AppError::Internal(format!("Failed to query photos: {}", e)))?
        .filter_map(|r| r.ok())
        .collect();

    let mut tagged = 0;
    for (photo_id, lat, lng, timestamp) in rows {
        let dt = DateTime::from_timestamp(timestamp, 0)
            .unwrap_or_else(|| DateTime::from_timestamp(0, 0).unwrap())
            .with_timezone(&Local);

        let date = dt.date_naive();

        match fetch_weather(lat, lng, date) {
            Ok(label) => {
                let classification = AiClassification {
                    id: None,
                    photo_id,
                    category: "rule".into(),
                    label,
                    confidence: 1.0,
                };
                if insert_classification_with_type(conn, &classification, "rule_weather").is_ok() {
                    tagged += 1;
                }
            }
            Err(e) => {
                eprintln!("Weather tagging failed for photo {}: {}", photo_id, e);
                // Continue to next photo
            }
        }
    }

    Ok(tagged)
}
```

- [ ] **Step 2: 验证编译**

```bash
cd src-tauri && cargo check
```

- [ ] **Step 3: 提交**

```bash
git add src-tauri/src/tags/weather_tagger.rs
git commit -m "feat: add weather tagging with Open-Meteo free API"
```

---

### Task 6: 色调分析标签

**Files:**
- Create: `src-tauri/src/tags/tone_tagger.rs` — 色调分析模块

- [ ] **Step 1: 创建 tone_tagger.rs**

```rust
// src-tauri/src/tags/tone_tagger.rs
use image::imageops::FilterType;
use rusqlite::Connection;
use std::path::Path;

use crate::db::classification_dao::insert_classification_with_type;
use crate::error::{AppError, AppResult};
use crate::models::AiClassification;

/// Analyze a thumbnail image and return tone labels.
///
/// Uses HSV color space to determine warm/cool tones
/// and brightness for light/dark labels.
fn analyze_tone(thumbnail_path: &str) -> Option<Vec<String>> {
    let img = image::open(thumbnail_path).ok()?;

    // Resize to a small size for fast analysis
    let img = img.resize(64, 64, FilterType::Nearest);

    let mut hue_sum: f64 = 0.0;
    let mut value_sum: f64 = 0.0;
    let mut pixel_count: u64 = 0;

    for (_, _, pixel) in img.pixels() {
        let [r, g, b, _] = pixel.0;
        let (h, _s, v) = rgb_to_hsv(r, g, b);

        // Only count pixels with meaningful saturation (skip grays)
        let (_, s, _) = rgb_to_hsv(r, g, b);
        if s > 0.1 {
            hue_sum += h;
            pixel_count += 1;
        }
        value_sum += v as f64;
    }

    if pixel_count == 0 {
        return None;
    }

    let avg_hue = hue_sum / pixel_count as f64;
    let avg_value = value_sum / (img.width() * img.height()) as f64;

    let mut labels = Vec::new();

    // Warm vs cool (hue-based)
    // Warm: 0-60° (red-yellow), Cool: 180-270° (blue-cyan)
    if avg_hue <= 60.0 || avg_hue >= 330.0 {
        labels.push("暖调".to_string());
    } else if (180.0..=270.0).contains(&avg_hue) {
        labels.push("冷调".to_string());
    }

    // Light vs dark (value-based)
    if avg_value > 180.0 {
        labels.push("明亮".to_string());
    } else if avg_value < 80.0 {
        labels.push("暗调".to_string());
    }

    if labels.is_empty() {
        None
    } else {
        Some(labels)
    }
}

/// Convert RGB (0-255) to HSV (H: 0-360, S: 0-1, V: 0-1).
fn rgb_to_hsv(r: u8, g: u8, b: u8) -> (f64, f64, f64) {
    let r = r as f64 / 255.0;
    let g = g as f64 / 255.0;
    let b = b as f64 / 255.0;

    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let delta = max - min;

    let h = if delta == 0.0 {
        0.0
    } else if max == r {
        60.0 * (((g - b) / delta) % 6.0)
    } else if max == g {
        60.0 * ((b - r) / delta + 2.0)
    } else {
        60.0 * ((r - g) / delta + 4.0)
    };

    let h = if h < 0.0 { h + 360.0 } else { h };
    let s = if max == 0.0 { 0.0 } else { delta / max };
    let v = max;

    (h, s, v)
}

/// Run tone analysis on photos that have small thumbnails.
pub fn run_tone_tagging(conn: &Connection, batch_size: usize) -> AppResult<usize> {
    let query = "
        SELECT p.id, p.path FROM photos p
        WHERE p.deleted = 0
          AND p.id NOT IN (
              SELECT photo_id FROM ai_classifications WHERE tag_type = 'rule_tone'
          )
        LIMIT ?
    ";

    let mut stmt = conn.prepare(query).map_err(|e| {
        AppError::Internal(format!("Failed to prepare query: {}", e))
    })?;

    let rows: Vec<(i64, String)> = stmt
        .query_map([batch_size as i64], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(|e| AppError::Internal(format!("Failed to query photos: {}", e)))?
        .filter_map(|r| r.ok())
        .collect();

    let mut tagged = 0;
    for (photo_id, path) in rows {
        // Try to find small thumbnail
        let thumb_path = find_thumbnail(&path);
        let labels = match thumb_path.and_then(|p| analyze_tone(&p)) {
            Some(labels) => labels,
            None => continue,
        };

        for label in labels {
            let classification = AiClassification {
                id: None,
                photo_id,
                category: "rule".into(),
                label,
                confidence: 1.0,
            };
            let _ = insert_classification_with_type(conn, &classification, "rule_tone");
        }
        tagged += 1;
    }

    Ok(tagged)
}

/// Find the small thumbnail for a given photo path.
/// Thumbnails are stored in .pf/small/ directory.
fn find_thumbnail(photo_path: &str) -> Option<String> {
    // Extract filename from path
    let filename = std::path::Path::new(photo_path)
        .file_name()?
        .to_str()?;

    // Get the project root from the photo path
    // Photos are in the project root or subdirectories
    // Thumbnails are in .pf/small/
    let photo_dir = std::path::Path::new(photo_path).parent()?;

    // Walk up to find .pf directory
    let mut current = photo_dir;
    loop {
        let pf = current.join(".pf/small");
        if pf.exists() {
            let thumb = pf.join(filename);
            if thumb.exists() {
                return thumb.to_str().map(String::from);
            }
            break;
        }
        current = current.parent()?;
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rgb_to_hsv() {
        // Red
        let (h, s, v) = rgb_to_hsv(255, 0, 0);
        assert!((h - 0.0).abs() < 1.0);
        assert!((s - 1.0).abs() < 0.01);
        assert!((v - 1.0).abs() < 0.01);

        // Green
        let (h, _, _) = rgb_to_hsv(0, 255, 0);
        assert!((h - 120.0).abs() < 1.0);

        // Blue
        let (h, _, _) = rgb_to_hsv(0, 0, 255);
        assert!((h - 240.0).abs() < 1.0);

        // Gray
        let (_, s, _) = rgb_to_hsv(128, 128, 128);
        assert!(s < 0.01);
    }
}
```

- [ ] **Step 2: 运行单元测试**

```bash
cd src-tauri && cargo test tone_tagger --no-fail-fast
```

Expected: 1 test pass

- [ ] **Step 3: 提交**

```bash
git add src-tauri/src/tags/tone_tagger.rs
git commit -m "feat: add tone analysis tagging"
```

---

### Task 7: 前端 — SmartAlbumView 复用 PhotoGrid 浏览能力

**Files:**
- Modify: `src/components/SmartAlbumView.tsx` — 相册详情页改用 PhotoGrid + 添加 Shape 切换
- Modify: `src/api/tauri.ts` — 添加相册照片批量获取 API（如需要）

**方案**: 最简单的方式——在 SmartAlbumView 的详情页中，不重新造轮子，而是：
1. 复用 PhotoCard + 缩略图加载逻辑
2. 添加 ThumbnailToolbar（Shape 切换）
3. 点击/双击照片调用已有的 onSelectPhoto / setLightboxPhotoId

- [ ] **Step 1: 修改 SmartAlbumView.tsx 详情页**

完整重写 SmartAlbumView 的详情视图部分，使其包含 Shape 切换和缩略图工具栏：

```tsx
import React, { useEffect, useState, useCallback, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import * as api from "../api/tauri";
import { useStore } from "../hooks/usePhotos";
import PhotoCard from "./PhotoCard";
import ThumbnailToolbar from "./ThumbnailToolbar";
import { useVirtualGrid, calculateColumnCount } from "../hooks/useVirtualGrid";
import type { SmartAlbum, Photo } from "../types";

const GAP = 8;

// ... Thumb component stays the same ...

export default React.memo(function SmartAlbumView({ onSelectPhoto }: Props) {
  const [albums, setAlbums] = useState<SmartAlbum[]>([]);
  const [selectedAlbum, setSelectedAlbum] = useState<SmartAlbum | null>(null);
  const [albumPhotos, setAlbumPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  const { thumbnailShape, thumbnailSize, setSelectedPhotoId, setLightboxPhotoId } = useStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // ... album list loading stays the same ...

  const handleSelectPhoto = useCallback((id: number) => {
    setSelectedPhotoId(id);
  }, [setSelectedPhotoId]);

  const handleDoubleClickPhoto = useCallback((id: number) => {
    setLightboxPhotoId(id);
  }, [setLightboxPhotoId]);

  // Detail view with PhotoGrid-like rendering
  if (selectedAlbum) {
    const columnCount = calculateColumnCount(width, thumbnailSize, GAP);
    const { parentRef, virtualizer, getItemsForRow } = useVirtualGrid({
      itemCount: albumPhotos.length,
      columnCount,
      cellHeight: thumbnailSize,
      gap: GAP,
      overscan: 3,
    });

    return (
      <div className="h-full flex flex-col">
        <div className="px-4 pt-4 pb-2 flex items-center gap-3">
          <button
            onClick={handleBack}
            className="text-text-muted hover:text-text-primary text-sm transition-colors"
          >
            &larr; 返回
          </button>
          <h2 className="text-xl font-bold">{selectedAlbum.name}</h2>
          <span className="text-sm text-text-muted">
            ({albumPhotos.length} 张照片)
          </span>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center text-text-muted">
            Loading...
          </div>
        ) : albumPhotos.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-text-muted">
            暂无照片
          </div>
        ) : thumbnailShape === "proportional" ? (
          // Proportional mode: simple masonry
          <div className="flex-1 overflow-y-auto p-2 columns-2 md:columns-3 lg:columns-4 gap-2">
            {albumPhotos.map((photo) => (
              <div
                key={photo.id}
                className="mb-2 break-inside-avoid cursor-pointer hover:opacity-80 transition-opacity"
                onClick={() => handleSelectPhoto(photo.id!)}
                onDoubleClick={() => handleDoubleClickPhoto(photo.id!)}
              >
                <Thumb photoId={photo.id!} />
              </div>
            ))}
          </div>
        ) : (
          // Square mode: virtualized grid
          <>
            <ThumbnailToolbar />
            <div ref={parentRef} className="flex-1 overflow-auto p-2">
              <div style={{ height: `${virtualizer.getTotalSize()}px`, width: "100%", position: "relative" }}>
                {virtualizer.getVirtualItems().map((virtualRow) => (
                  <div
                    key={virtualRow.index}
                    className="absolute flex gap-2"
                    style={{ transform: `translateY(${virtualRow.start}px)`, left: 0, right: 0 }}
                  >
                    {getItemsForRow(virtualRow.index).map((idx) => {
                      const photo = albumPhotos[idx];
                      if (!photo) return null;
                      return (
                        <PhotoCard
                          key={photo.id}
                          photo={photo}
                          onClick={() => handleSelectPhoto(photo.id!)}
                          onDoubleClick={() => handleDoubleClickPhoto(photo.id!)}
                          size={thumbnailSize}
                          shape="square"
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    );
  }

  // ... list view stays the same ...
});
```

- [ ] **Step 2: 验证前端编译**

```bash
npm run build 2>&1 | head -20
```

Expected: 编译成功

- [ ] **Step 3: 提交**

```bash
git add src/components/SmartAlbumView.tsx
git commit -m "feat: SmartAlbumView detail page reuses PhotoGrid browsing features"
```

---

### Task 8: 前端 — People 视图人脸卡片改进

**Files:**
- Modify: `src/components/FaceView.tsx` — 缩小卡片 + 扩大裁切范围
- Modify: `src-tauri/src/commands/faces.rs` — 确保 get_cluster_face_thumbnail 返回包含头部的裁切

- [ ] **Step 1: 修改 FaceView 卡片尺寸和布局**

读取 `FaceView.tsx` 第 354-424 行，修改卡片网格：

当前网格是：
```tsx
<div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
```

改为更密集的网格：
```tsx
<div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-3">
```

- [ ] **Step 2: 修改 FaceThumb 裁切逻辑**

找到 FaceThumb 组件，修改其渲染逻辑。FaceThumb 使用 `api.getClusterFaceThumbnail(clusterId)` 获取图片。需要调整裁切范围——在 Rust 端或前端 CSS 实现。

**前端方案（更简单）**: 在 FaceThumb 的 `<img>` 上添加 CSS：

```tsx
<img
  src={thumb}
  alt=""
  className="w-full h-full object-cover"
  style={{
    objectPosition: "center 30%",  // 向下偏移，显示更多头部
    transform: "scale(0.85)",      // 缩小 15%，显示更多周围区域
  }}
/>
```

或者直接在 FaceThumb 的容器上调整：

```tsx
<div className="w-full aspect-square overflow-hidden rounded-lg bg-surface-primary relative">
  {thumb ? (
    <img
      src={thumb}
      alt=""
      className="w-full h-full object-cover"
      style={{ objectPosition: "center 25%" }}
    />
  ) : (
    <div className="w-full h-full flex items-center justify-center text-text-muted text-xs">No face</div>
  )}
</div>
```

`objectPosition: "center 25%"` 会让图片在容器中向上偏移，显示更多头顶区域。

- [ ] **Step 3: 验证前端编译**

```bash
npm run build 2>&1 | head -20
```

- [ ] **Step 4: 提交**

```bash
git add src/components/FaceView.tsx
git commit -m "feat: shrink face cards and show more head area in People view"
```

---

### Task 9: 前端 — PersonHeader 显示照片数量

**Files:**
- Modify: `src/components/PhotoGrid.tsx` — PersonHeader 已显示数量，确认正确

根据代码审查，PersonHeader 已经显示 `{photoCount} 张照片`（第 95 行）。这个功能已经存在，不需要改动。

确认测试：启动应用，点击 People 中的某个 Person，确认标题后显示数量。

---

### Task 10: 前端 — TagView 添加手动运行规则按钮

**Files:**
- Modify: `src/components/TagView.tsx` — 添加"运行标签规则"按钮
- Modify: `src/api/tauri.ts` — 添加 `runTagRules` API
- Modify: `src-tauri/src/main.rs` — 注册 tag_rules 命令（已在 Task 3 中完成）

- [ ] **Step 1: 添加前端 API**

在 `src/api/tauri.ts` 末尾添加：

```typescript
export async function runTagRules(): Promise<string> {
  return invoke<string>("cmd_run_tag_rules");
}
```

- [ ] **Step 2: 在 TagView 添加按钮**

读取 `TagView.tsx`，找到 AI worker health indicator 和 "Classify Photos" 按钮区域，在其旁边添加 "Run Tag Rules" 按钮。

- [ ] **Step 3: 验证前端编译**

```bash
npm run build 2>&1 | head -20
```

- [ ] **Step 4: 提交**

```bash
git add src/api/tauri.ts src/components/TagView.tsx
git commit -m "feat: add Run Tag Rules button to TagView"
```

---

### Task 11: 端到端测试 + 最终提交

- [ ] **Step 1: 完整编译验证**

```bash
cd src-tauri && cargo build --release 2>&1 | tail -5
```

- [ ] **Step 2: 运行所有 Rust 测试**

```bash
cd src-tauri && cargo test 2>&1 | tail -10
```

- [ ] **Step 3: 前端构建验证**

```bash
npm run build 2>&1 | tail -5
```

- [ ] **Step 4: 最终提交**

```bash
git status
git log --oneline -10
```

确保所有改动都已提交。
