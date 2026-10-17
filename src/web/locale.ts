import { handLabelEn, handNameZh, streetLabelZh } from "../shared/format.ts";

export type Language = "zh" | "en";
export const LANGUAGE_KEY = "holdem.language";

/** UI copy only. Player names, chat messages and model names are never translated. */
export const MESSAGES: ReadonlyArray<readonly [string, string]> = [
  ["德州扑克", "Texas Hold’em"], ["NPC 牌桌", "POKER ROOM"],
  ["暗牌", "Hidden card"], ["空位", "Open seat"], ["入座", "Sit down"],
  ["上桌筹码", "Buy-in amount"], ["加机器人", "Add bot"], ["下一手发牌", "Joins next hand"],
  ["收起座位选项", "Close seat options"], ["你的最佳牌型", "Your best hand"],
  ["庄家按钮", "Dealer button"], ["离座，把筹码收回来", "Stand up and take your chips"],
  ["离座", "Stand up"], ["让这个机器人离桌", "Remove this bot after the hand"], ["离桌", "Remove"],
  ["弃牌", "Fold"], ["过牌", "Check"], ["跟注", "Call"], ["下注", "Bet"], ["加注到", "Raise to"], ["全下", "All-in"],
  ["你", "You"], ["轮到你行动", "Your turn"], ["可以免费过牌", "Check is free"],
  ["加注额", "Raise amount"], ["加注金额", "Raise target"], ["手动输入加注金额", "Enter raise target"],
  ["⅓池", "⅓ Pot"], ["半池", "½ Pot"], ["底池", "Pot"],
  ["桌边聊天", "Table chat"], ["说点什么…", "Say something…"], ["聊天输入框", "Chat message"], ["发送", "Send"],
  ["房间设置", "Room settings"], ["座位数", "Seats"], ["（有人入座后不能改）", " (locked while occupied)"],
  ["模式", "Mode"], ["（开局后不能改）", " (locked after first deal)"],
  ["现金局（盲注固定）", "Cash game (fixed blinds)"], ["锦标赛（盲注递增）", "Tournament (rising blinds)"],
  ["起始筹码（每个新入座玩家的默认买入）", "Default buy-in for new players and bots"],
  ["行动限时（秒，0 = 关闭）", "Action clock (seconds, 0 = off)"],
  ["小盲", "Small blind"], ["大盲", "Big blind"], ["（本手结束可改）", " (between hands only)"],
  ["自动开始下一手牌", "Auto-deal next hand"], ["开启", "On"], ["关闭", "Off"], ["间隔（秒）", "Delay (seconds)"],
  ["手动开始：每手结束点「开始下一手」", "Manual: select ‘Next hand’ after each hand"],
  ["机器人输光后自动重新买入", "Auto-rebuy busted bots"],
  ["输光的机器人会按各自买入金额重新买入", "Busted bots rebuy their configured amount"],
  ["输光的机器人坐着看戏，不再补筹码", "Busted bots sit out until removed"],
  ["每多少手升盲", "Hands per blind level"], ["每次盲注倍数", "Blind multiplier"],
  ["现金局：盲注保持不变，可以随时调整。", "Cash game: blinds stay fixed and can be edited between hands."],
  ["取消", "Cancel"], ["保存", "Save"], ["没有公共牌", "No community cards"],
  ["已弃牌（底牌不入档）", "Folded (cards private)"], ["未亮牌", "Not shown"], ["弃牌结束", "Won by folds"], ["摊牌", "Showdown"],
  ["行动记录", "Action history"], ["复制这个邀请链接发给朋友：", "Copy this invite link for your friends:"],
  ["现金局", "Cash game"], ["房间", "Room"], ["已复制 ✓", "Copied ✓"], ["复制邀请链接", "Copy invite"],
  ["盲注", "Blinds"], ["⚙ 房间设置", "⚙ Settings"], ["已连接", "Connected"], ["连接中…", "Connecting…"],
  ["重连中…", "Reconnecting…"], ["未连接", "Disconnected"], ["离开", "Leave"], ["准备开桌", "Ready to play"],
  ["好对手，就位。", "Your table is ready."], ["选一个空位坐下，或直接开始一桌。", "Pick a seat or start a table."],
  ["快速开桌", "Quick start"], ["自动入座 · 最多 3 位机器人陪练", "Auto-seat · Up to 3 bot opponents"],
  ["本手已结算", "Hand settled"], ["筹码已收进底池", "Bets collected"], ["牌局动态", "Table activity"],
  ["本手", "This hand"], ["历史", "History"], ["故事从第一手开始", "It starts with the first hand"],
  ["盲注、下注和结算会记录在这里。", "Blinds, actions and results appear here."],
  ["还没有打完的牌局。每手结束后会自动归档，随时点开回看。", "Completed hands are saved here. Select one to replay it."],
  ["翻前结束", "Ended preflop"], ["大模型", "Model"], ["未接入 · 本地决策", "Local strategy"],
  ["房间码", "Room code"], ["你的位置", "Your seat"], ["旁观", "Spectating"],
  ["你的手牌", "Your cards"], [" · 已弃牌", " · Folded"], ["其余玩家弃牌", "Everyone else folded"],
  ["开始下一手", "Next hand"], ["重新买入的筹码", "Additional buy-in"], ["重新买入", "Buy in"],
  ["你在锦标赛出局了，可以留下来观战。", "You are out of the tournament. You can keep watching."],
  ["你正在观战 · 选择一个空位入座", "Spectating · Choose an open seat to join"],
  ["等待下一步行动。", "Waiting for the next move."], ["大模型配置", "Model configuration"],
  ["保持原样", "Keep current key"], ["接口地址（留空 = 默认）", "API base URL (blank = default)"],
  ["模型名（留空 = 默认）", "Model name (blank = default)"], ["关闭大模型", "Disable model"],
  ["来一局？", "Ready to play?"], ["一个昵称，就能上桌。", "A nickname is all you need."],
  ["开桌方式", "How to join"], ["创建房间", "Create room"], ["加入朋友", "Join friends"],
  ["你的昵称", "Your nickname"], ["牌桌上怎么称呼你？", "What should we call you?"], ["朋友的房间码", "Friend’s room code"],
  ["创建后可复制邀请链接，也可以直接和机器人练习。", "Invite friends with a link or practise against bots."],
  ["游戏服务未连接", "Game service unavailable"], ["暂时无法创建或加入房间，请稍后重试。", "Cannot create or join a room. Please try again."],
  ["给部署者的诊断", "Deployment diagnostics"], ["请启动 Node 游戏服务，并转发 API 和 WebSocket 请求。", "Start the Node game service and proxy API and WebSocket traffic."],
  ["重新检查", "Check again"], ["正在检查游戏服务…", "Checking game service…"], ["正在连接…", "Connecting to room…"],
  ["加入房间", "Join room"], ["取消连接", "Cancel connection"], ["现金局 / 锦标赛 · 仅使用虚拟筹码", "Cash / Tournament · Virtual chips only"],
  ["五种个性，同一张牌桌。", "Five personalities. One table."], ["你会遇到怎样的对手？", "Who will you face?"],
  ["连接游戏服务后显示全部对手。", "Connect to the game service to see all opponents."],
  ["游戏服务未连接 · AI 状态暂不可用", "Game service unavailable · AI status unavailable"],
  ["AI 状态暂不可用，正在重新检查…", "Checking AI status…"],
  ["本地策略机器人 · 管理员配置 API Key 后启用大模型", "Local bots · The administrator can configure an API key to enable the model"],
  ["修改大模型配置", "Edit model configuration"], ["配置大模型", "Configure model"],
  ["API 调用", "API requests"], ["等待机器人行动", "Waiting for a bot action"], ["最近调用失败", "Last request failed"],
  ["已成功调用", "Request succeeded"], ["正在测试…", "Testing…"], ["测试连接", "Test connection"],
  ["测试当前已保存的配置，会产生一次请求和少量 token 用量。", "Test the saved configuration. Uses one request and a few tokens."],
  ["接口返回的累计 token；重启服务或更换配置后清零。包含格式不合法但接口已返回的响应。", "Provider-reported token totals. Reset on restart or configuration changes; includes invalid model replies."],
  ["连接测试失败", "Connection test failed"], ["无法连接游戏服务", "Cannot reach game service"], ["保存失败", "Could not save"],
  ["无法连接牌桌，请重试或联系网站管理员检查游戏服务连接。", "Cannot connect to the table. Retry or contact the administrator."],
  ["牌桌已关闭", "Table closed"], ["所有真人已离桌，牌桌已自动关闭。", "All human players left. The table has closed."],
  ["只有房主可以管理机器人", "Only the host can manage bots"], ["只有房主可以修改房间设置", "Only the host can edit settings"],
  ["你还没有入座", "Take a seat first"], ["该座位已经被占用", "This seat is taken"],
  ["你已经在座上了，先点自己座位上的「离座」再换座", "Stand up before changing seats"],
  ["已申请离座，不能追加买入", "You are leaving; additional buy-ins are unavailable"],
  ["锦标赛不能重新买入，出局就是出局", "Tournament rebuys are not allowed"],
  ["只能在本手结束后亮出自己的获胜底牌", "Only the winner can show their own cards after everyone folds"],
  ["当前没有进行中的牌局", "No hand in progress"], ["还没轮到你行动", "It is not your turn"],
  ["至少需要两位有筹码的玩家", "At least two funded players are needed"],
  ["至少需要一位在线真人玩家入座", "An online human player must be seated"],
  ["游戏服务配置数据不完整，请检查部署版本", "Incomplete game service configuration; check the deployed version"],
  ["游戏服务请求超时或不可达", "Game service timed out or is unreachable"],
  ["请求超时", "Request timed out"], ["请求失败", "Request failed"],
  ["响应里没有可用的文本", "No usable text in the response"], ["模型没有给出合法的候选动作", "The model returned an invalid action"],
  ["网络连接超时", "Network connection timed out"], ["连接被拒绝（ECONNREFUSED）", "Connection refused (ECONNREFUSED)"],
  ["网络连接中断（ECONNRESET）", "Connection reset (ECONNRESET)"], ["接口证书验证失败", "API certificate verification failed"],
  ["牌局进行中不能修改盲注", "Blinds can only change between hands"],
  ["有人入座时不能修改座位数", "Seat count is locked while occupied"], ["牌局已经开始，不能切换模式", "Mode is locked after the first deal"],
  ["已经有一手牌在进行中", "A hand is already in progress"], ["那个座位上没有机器人", "There is no bot in that seat"],
  ["A SEAT FOR EVERY PERSONALITY", "A SEAT FOR EVERY PERSONALITY"], ["TAKE YOUR SEAT", "TAKE YOUR SEAT"],
  ["TABLE NOTES", "TABLE NOTES"], ["MEET THE TABLE", "MEET THE TABLE"],
];

const dictionary = new Map<string, readonly [string, string]>();
for (const pair of MESSAGES) { dictionary.set(pair[0], pair); dictionary.set(pair[1], pair); }

export function translate(text: string, language: Language, english?: string): string {
  const pair = dictionary.get(text);
  if (language === "zh") return pair?.[0] ?? text;
  if (english || pair) return english ?? pair![1];
  // Validation messages are generated by the authoritative server. Translate
  // the known patterns, without rewriting player names or free-form chat.
  const patterns: Array<[RegExp, string]> = [
    [/^买入必须在 (\d+) 到 (\d+) 之间$/, "Buy-in must be between $1 and $2"],
    [/^买入至少要两个大盲（(\d+)）$/, "Buy-in must be at least two big blinds ($1)"],
    [/^筹码和待到账买入合计不能超过 (\d+)$/, "Stack and pending buy-ins cannot exceed $1"],
    [/^没有 (\d+) 号座位$/, "No seat $1"],
    [/^桌上已经有一个「(.*)」了$/, "$1 is already seated"],
    [/^运行环境禁止网络访问（(.*)）$/, "Network access denied by the runtime ($1)"],
    [/^域名解析失败（(.*)）$/, "DNS lookup failed ($1)"],
    [/^(.*) 必须在 (\d+) 到 (\d+) 之间$/, "Invalid setting: allowed range $2–$3"],
    [/^起始筹码至少要有两个大盲$/, "Default buy-in must be at least two big blinds"],
    [/^大盲必须大于小盲$/, "Big blind must exceed small blind"],
  ];
  for (const [pattern, replacement] of patterns) if (pattern.test(text)) return text.replace(pattern, replacement);
  return text;
}

export function actionLabel(text: string, language: Language): string {
  if (language === "en") return text;
  return text.replace(/^Raise to /, "加注到 ").replace(/^Bet /, "下注 ")
    .replace(/^Fold$/, "弃牌").replace(/^Check$/, "过牌").replace(/^Call$/, "跟注");
}

export function handLabel(category: number, language: Language, ranks: readonly number[] = []): string {
  if (language === "en") return handLabelEn(category);
  if (ranks.length) return handNameZh(category, ranks);
  return ["高牌", "一对", "两对", "三条", "顺子", "同花", "葫芦", "四条", "同花顺"][category] ?? "";
}

export function streetLabel(street: string, language: Language): string {
  return language === "zh" ? streetLabelZh(street)
    : ({ preflop: "Preflop", flop: "Flop", turn: "Turn", river: "River", complete: "Hand complete" }[street] ?? street);
}

export const PERSONA_EN: Record<string, string> = {
  gto: "A steady, pot-odds player who stays disciplined with marginal hands.",
  lag: "Wide ranges, relentless pressure and plenty of semi-bluffs.",
  rock: "Waits for strong hands and stays out of trouble.",
  tanxuan: "Big bets and relentless pressure, including polarized river overbets.",
  elton: "Careful hand reading, small pots and precise value bets.",
};
