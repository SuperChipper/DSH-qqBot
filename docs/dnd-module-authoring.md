# 跑团模组编写指南

这份指南讲怎么把一本冒险模组（或者你自己的剧本）写成 bot 能跑的 JSON。
类型定义在 `src/dnd/adventure.ts` 和 `src/dnd/dungeon.ts`，这里讲的是怎么用。

> **版权**：商业模组（官方冒险、付费 PDF）转出来的 JSON 只放在本机的 `<dnd 根目录>/adventures/`，
> 不要提交进仓库、不要分享。文本用自己的话转述，不要整段照抄朗读框。

## 1. 放在哪

`<dnd 根目录>` 默认是 agent 工作目录下的 `dnd/`（配置项 `dnd.root`）。

| 写法 | 适合 |
|---|---|
| `adventures/<id>.json` | 小模组，一个文件写完 |
| `adventures/<id>/adventure.json` + `adventures/<id>/sites/*.json` | 大模组，每个场景一个文件，方便分批写 |

拆文件时 `adventure.json` 可以不写 `sites`（或只写一部分），`sites/` 下的文件按文件名排序后追加进去。
旧的单地城格式（`dungeons/*.json`）还能用，会被当成只有一个场景的模组。

加载规则：

- 文件改了会自动重新读（按修改时间），不用重启 bot；但正在跑的团只在下一回合看到新内容。
- 结构错误：这个模组不加载，日志里有 `im-qqbot: 模组 xxx 加载失败: 原因`。
- 可疑但不致命的地方（没人设置的 flag、线索太少的场景）：照样加载，日志里打 `im-qqbot: 模组 xxx: 警告`。
- 群里发 `/dnd dungeons` 能看到加载成功的模组；`/dnd new <id>` 开团。

## 2. 拆书的顺序

一本模组按这个顺序拆最不容易漏：

1. **先读背景和概览**，写 `truth`（DM 才知道的真相：反派是谁、要什么、东西真正在哪）和 `chapters`。
2. **每章定玩法**：线性（伏击→巢穴）、城镇枢纽（地点 + NPC + 传闻 + 任务）、沙盒（大地图多据点）、地城。
3. **每个场景**：通用规则（General Features）→ `features`；地图 → 房间坐标和出口；
   朗读框 → `playerView`；正文拆成遭遇（`encounter`）、检定和宝物（`dmNotes`）、条件变化（`triggers`）。
4. **抽实体**：NPC 表 → `npcs`；「X 知道什么」侧栏 → `knowledge`；传闻 → 带 `leads` 的 `facts`；任务 → `quests`。
5. **画线索图**：每个关键地点至少两条线索指过去（校验会对少于两条的打警告）。
6. **最后补 flag**：所有条件里用到的状态都要在 `flags` 里声明，而且要有触发器/信息/任务奖励去设置它。

书里元素和字段的对照：

| 书里 | 写成 |
|---|---|
| 背景、反派计划 | `truth`（每条一句） |
| 冒险钩子 | `hook` |
| 章节、本章目标 | `chapters[].goal` / `dmGuide` |
| 地图上的一个地点 | `sites[]` |
| General Features（光照、声音、地形） | `site.features` |
| 编号区域 | `rooms[]` |
| 朗读框 | `room.playerView`（转述） |
| 区域正文的 DC、陷阱、宝物、怪物动机 | `room.dmNotes` |
| 粗体怪物名 | `room.encounter`（具名的头目写成 NPC） |
| Developments（如果……就……） | `room.triggers` |
| 状态变了之后的描述（水放干了、强盗被清掉） | `room.variants` |
| 暗门 | `exit.hidden: true` |
| 要爬、要游、要跳的通道 | `exit.check` |
| 锁着、要钥匙或口令的门 | `exit.requires` + `lockedText` |
| 具名 NPC、扮演提示 | `npcs[]` |
| 「What the X Know」侧栏 | `knowledge`（挂在场景或房间上） |
| 酒馆传闻 | NPC 或地点的 `facts`，`via: "rumor"` |
| 任务（谁给、做什么、奖励） | `quests[]` |
| 剧情里程碑升级 | `milestones[]` |

## 3. 字段参考

所有 id 用小写字母、数字、短横线。**房间 id 在整本模组里唯一**（建议加场景前缀，如 `ch-a3`）。

### 模组（顶层）

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` / `name` | ✓ | |
| `truth` | | DM 机密，每回合注入，写短 |
| `hook` | | 开团时念给玩家（`/dnd new` 直接发到群里） |
| `opening` | | 进第一个场景前 DM 带玩家做的事，一步一条（互相介绍、和委托人的交情、行进队形……）。新团先停在开场，DM 做完这些再 `dnd_story action=begin` 进第一个场景；开场期间不注入第一个房间的 DM 笔记，免得提前说漏 |
| `start` | ✓ | 开局所在房间 id；这个房间的 `encounter` 在开场结束时刷出（适合开场伏击） |
| `chapters` / `sites` / `npcs` / `leads` / `quests` / `flags` | | `sites` 至少一个 |
| `levels` | | `{ "start": 1, "end": 5 }`，只是说明 |
| `routes` | | 写了就只能沿路在场景间移动；不写则所有已知场景互通 |
| `milestones` | | `{ "level": 2, "when": 条件, "text": "说明" }`，满足时提示一次 |

### 章节

`{ id, name, mode, goal, dmGuide, exitWhen?, next? }`。`mode` 是 `linear | hub | sandbox | dungeon`（只是说明）。
只注入当前章的 `dmGuide`。`exitWhen` 满足时提示 DM 可以翻章；**全队都进了 `next` 章的场景时自动翻章**
（有人先去探路不算，回到旧场景也不会翻回去）。场景用 `site.chapter` 归章。

### 场景

| 字段 | 说明 |
|---|---|
| `kind` | `dungeon`（默认）或 `hub`（城镇） |
| `entry` | 从别的场景过来时进入的房间 |
| `features` | 通用规则，首次抵达和每回合注入 |
| `arrival` | 首次抵达时念给玩家 |
| `summary` | DM 一两句概述 |
| `knownWhen` | 满足前玩家不知道这个地方；不写 = 一开始就知道。线索 `points.site` 指向它时也会变成已知 |
| `knowledge` | 场景里无名群体知道的事 |

**dungeon**：房间要写坐标 `x y w h`（网格，地图用）和 `exits`，只能走相邻房间，离开场景要回到 `entry`。
**hub**：地点不用写坐标和出口（自动排成网格），已知地点之间随便走，从任何地点都能出发去别的场景；
地点可以用 `knownWhen` 藏起来，用 `shop: { "sells": "...", "maxPrice": 25 }` 标成店铺。`knownWhen` 只能用在城镇地点，入口不能藏。

### 房间

| 字段 | 说明 |
|---|---|
| `playerView` | 可以说给玩家的描述（短，3 句以内） |
| `dmNotes` | DC、陷阱、宝物、怪物战术；工具结果和注入里都有 |
| `exits` | `[{ to, label, hidden?, check?, requires?, lockedText? }]`；只写一边就双向连通 |
| `encounter` | 首次进入时刷出的怪物，见下 |
| `triggers` / `variants` | 见第 4 节 |
| `npcs` | 住在这里的 NPC id（`npc.home` 指过来的也算） |
| `knowledge` | 只在这个房间的群体知道的事 |

出口检定：`"check": { "skill": "运动", "dc": 10, "fail": "失败的后果" }`（或 `ability: "力量"`）。
工具给每个移动的人掷骰，没过的留在原地，`fail` 交给 DM 用 `dnd_apply` 结算。技能和属性中英文都行。

### 怪物（encounter / spawn / NPC 的 stat）

```json
{ "srd": "goblin", "name": "地精", "count": 2, "hp": 7, "ac": 15, "initBonus": 2,
  "attackBonus": 4, "damage": "1d6+2", "abilities": { "dex": 14 }, "notes": "灵巧脱逃……" }
```

`srd` 是 dnd5eapi.co 的 index，DM 可以用 `dnd_srd` 查全文。不在 SRD 的怪物自己把数据填全。
`count > 1` 时自动编号（地精1、地精2）。`traits: ["不死坚韧"]` 由工具自动处理。

### NPC

| 字段 | 说明 |
|---|---|
| `name` / `aliases` | 玩家怎么称呼都能找到 |
| `role` | DM 一句话：是谁、和主线的关系 |
| `look` | 玩家看得到的外貌神态 |
| `voice` / `motive` / `faction` | 扮演提示 |
| `home.room` | 平时在哪 |
| `attitude` | `friendly | indifferent | hostile` |
| `stat` | `{ "srd": "bugbear" }` 或完整怪物数据；不写 = 平民 |
| `knows` | 能透露的信息（`facts`） |
| `offers` | 发布的任务 id |
| `canJoin` | 会入队 |

NPC 只在两种情况下建角色卡：入队（`dnd_story npc join=true`，跟着队伍走）、和队伍打起来
（`fight=true`，留在自己房间、进那个房间的先攻）。光聊天的 NPC 不建卡。
**具名头目写成 NPC 时，开打要 `fight=true` 才会进先攻**，在 `dmNotes` 里提醒一句。

### 信息（facts）与知识块

```json
{ "id": "gob-leader", "text": "头目是一只熊地精，住在最里面的洞。", "via": "captured",
  "dc": 12, "requires": { "flag": "..." }, "leads": ["..."], "set": ["..."] }
```

`via`：`ask` 直接问；`persuade` / `intimidate` / `insight` 要检定（写 `dc`，DM 先 `dnd_check` 成功再传 `passed=true`）；
`captured` / `charmed` 对方被俘/被魅惑时；`rumor` 传闻。透露过的不会重复生效。
知识块：`{ "holder": "任意被俘的地精", "facts": [...] }`，挂在场景或房间上。

### 线索与任务

线索：`{ id, text, points: { site?, room?, npc?, quest? }, resolvedWhen? }`。玩家得知后指向的场景变成已知；
`resolvedWhen` 满足后不再进摘要。`points` 可以为空（只是一条记录在案的情报）。

任务：`{ id, name, giver?, brief, dmNotes?, target, completeWhen, failWhen?, reward }`。
`reward`：`{ gp?, items?, set?, text?, atGiver? }`。进行中的任务满足 `completeWhen` 时自动变成「目标达成」；
领奖用 `dnd_story quest status=rewarded to=<角色>`，金币和物品直接进那个角色的卡。

## 4. 触发器、变体和条件

**触发器**是书里的 Developments：「如果玩家在门厅吵闹，隔壁的守卫就会赶过来」。

```json
{ "id": "hall-noise", "when": "队伍在门厅大声争吵、砸东西或打起来",
  "then": "隔壁营房的两个守卫听到动静，拔出武器冲进门厅",
  "set": ["guards-alerted"], "requires": "...", "leads": [], "spawn": [], "once": true }
```

- `when` 是自然语言，**由 DM（模型）判断**局面吻合时调用 `dnd_story trigger`；当前房间没触发的事件会列在团况里。
- `then` 是发生了什么（DM 视角）；`set` / `clear` 改 flag；`leads` 给线索；`spawn` 在这个房间追加怪物（援兵）。
- 默认只触发一次，`"once": false` 可重复。
- 一条 Development 一个触发器；后续步骤用 `requires` 串起来（先放第一波水，才能放第二波）。

**变体**：条件满足时换一套描述，后面的覆盖前面的。

```json
"variants": [{ "when": "flood-1", "playerView": "东边的水池已经见底……" }]
```

**条件**写法（用在 `requires`、`knownWhen`、`completeWhen`、`when` 等处）：

| 写法 | 意思 |
|---|---|
| `"flag-id"` 或 `{ "flag": "flag-id" }` | flag 开着 |
| `{ "visited": "房间或场景 id" }` | 去过 |
| `{ "quest": "id", "status": "active" }` | 任务状态（可以写数组） |
| `{ "npc": "id", "alive": false }` | NPC 死了（还能写 `attitude`、`met`） |
| `{ "lead": "id" }` | 玩家知道这条线索 |
| `{ "level": 3 }` | 全队最低等级 ≥ 3 |
| `{ "all": [...] }` / `{ "any": [...] }` / `{ "not": ... }` | 组合 |

## 5. 写作建议

- `playerView` 短，只写看得见听得见的；DC、敌人位置、宝物全放 `dmNotes`。
  `playerView` 里不要写埋伏的预兆或要检定才看得出的东西，模型会照着念出来。
- `dmNotes` 里要等检定或近看才能说的内容，开头写清楚「以下要等……才能说」，模型更不容易剧透。
- `dmNotes` 里写清楚检定（技能 + DC + 后果），DM 才不会临场编。
- 暗门用 `hidden` 出口，不要只写在笔记里，否则地图和移动都不知道它存在。
- 不在书里的东西不要补：DM 规则要求它不编暗道和捷径，模组里没写的路就是走不通。
- 被俘、受伤的 NPC 入队时卡是满血的，在 `dmNotes` 提醒 DM 用 `dnd_apply` 调到书里的状态。
- 写完先看日志里的警告，再用 `/dnd new <id> 空卡` 在测试群跑一遍。

## 6. 最小示例

```json
{
  "id": "grey-mine",
  "name": "灰岩矿坑",
  "truth": ["工头被矿坑深处的东西控制了。"],
  "hook": "矿镇的矿工接连失踪。",
  "start": "camp-gate",
  "chapters": [{ "id": "town", "name": "矿镇", "mode": "hub", "goal": "打听矿坑的事", "dmGuide": "让玩家和老矿工聊天。" }],
  "flags": [{ "id": "vault-open", "label": "金库已开" }],
  "sites": [
    { "id": "camp", "name": "矿镇营地", "kind": "hub", "chapter": "town", "entry": "camp-gate",
      "rooms": [
        { "id": "camp-gate", "name": "营地大门", "playerView": "木栅栏围着几顶帐篷。" },
        { "id": "camp-tavern", "name": "酒棚", "playerView": "几张长凳。", "dmNotes": "老矿工在角落喝酒。" }
      ] },
    { "id": "mine", "name": "灰岩矿坑", "entry": "mine-mouth", "knownWhen": { "lead": "mine-map" },
      "rooms": [
        { "id": "mine-mouth", "name": "矿口", "x": 0, "y": 0, "w": 3, "h": 3, "playerView": "矿车倒在铁轨边。", "dmNotes": "",
          "exits": [{ "to": "mine-vault", "label": "铁门", "requires": "vault-open", "lockedText": "铁门锁着" }] },
        { "id": "mine-vault", "name": "金库", "x": 4, "y": 0, "w": 3, "h": 3, "playerView": "矿石箱。", "dmNotes": "50 gp。", "exits": [] }
      ] }
  ],
  "npcs": [
    { "id": "old-miner", "name": "老矿工", "role": "退休矿工", "look": "满脸煤灰的老头", "motive": "找侄子",
      "home": { "room": "camp-tavern" }, "attitude": "friendly",
      "knows": [
        { "id": "mine-rumor", "text": "矿坑在北边山腰上。", "via": "ask", "leads": ["mine-map"] },
        { "id": "vault-word", "text": "铁门口令是「灰岩」。", "via": "persuade", "dc": 13, "set": ["vault-open"] }
      ] }
  ],
  "leads": [{ "id": "mine-map", "text": "矿坑在北边山腰", "points": { "site": "mine" } }],
  "quests": []
}
```

这个示例加载时会打一条警告「场景 mine 只有 1 条线索指向它」——故意留着，让你看看警告长什么样；
真写模组时给关键场景多铺一条线索。完整的可运行示例见 `src/dnd/adventure.test.ts` 里的 `fixture()`。
