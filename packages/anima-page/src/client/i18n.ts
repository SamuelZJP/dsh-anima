/**
 * Page copy in Chinese (default) and English. The owner picks the language in
 * the page header; the choice is kept in localStorage. Values that come from
 * the Host (ids, codes, her text, error hints) are shown as they are.
 * @module @anima/page/client/i18n
 */

/** Languages the page ships. */
export const LANGS = ['zh', 'en'] as const
export type Lang = (typeof LANGS)[number]

const zh = {
  'lang.switch': 'English',
  'lang.switchTitle': '切换到英文',

  'tab.status': '状态',
  'tab.persona': '人格',
  'tab.memory': '记忆',
  'tab.inbox': '目标 · 审批 · 发件箱',
  'tab.activity': '活动',
  'tab.platforms': '平台',
  'tab.settings': '设置',

  'head.asleep': '睡着',
  'head.awake': '醒着',
  'head.paused': '已暂停',

  'common.cancel': '取消',
  'common.reason': '理由',
  'common.loading': '加载中…',
  'common.none': '无',
  'common.id': '编号',

  'format.notJson': '不是有效的 JSON：{error}',
  'format.notObject': '配置必须是 JSON 对象。',

  // Status
  'status.paused': '已暂停',
  'status.running': '运行中',
  'status.resume': '恢复',
  'status.pause': '暂停',
  'status.resumed': '已恢复。',
  'status.pausedNote': '已暂停：任何消息都到不了她，所有行为都会被拒绝；她的心跳照常。',
  'status.asleepSince': '{since} 起睡着（{why}）',
  'status.tookHer': '困意带走了她',
  'status.wentToBed': '她自己去睡了',
  'status.awakeSince': '{since} 起醒着（{by}）',
  'status.wake': '叫醒她',
  'status.woke': '她醒了；她的清醒会话会带着收件箱打开。',
  'status.updates': '每 5 秒刷新。',
  'status.clock': '她的时钟',
  'status.realTime': '实时',
  'status.speed': '{speed}× 速度',
  'status.day': '日期 {day}',
  'status.heartbeat': '心跳',
  'status.next': '下一次',
  'status.last': '上一次',
  'status.total': '累计',
  'status.totalValue': '{beats} 次心跳，{wakings} 次清醒，{sleeps} 次睡眠',
  'status.wakingSession': '清醒会话',
  'status.prepared': '（已准备）',
  'status.energyMood': '精力与情绪',
  'status.energy': '精力',
  'status.valence': '效价',
  'status.valenceHint': '（−1 糟 … 1 好）',
  'status.arousal': '唤醒度',
  'status.arousalHint': '（0 平静 … 1 兴奋）',
  'status.budget': '预算（{mode}）',
  'status.modeDay': '白天',
  'status.modeNight': '夜间',
  'status.tokensOf': '{used} / {budget} 计费 token',
  'status.dayNight': '白天 {day} · 夜间 {night}',
  'status.initiates': '主动发起的对话 {used} / {perDay}',
  'status.sleepInbox': '睡眠与收件箱',
  'status.pressure': '睡眠压力',
  'status.sleepNote': '她想睡就去睡；足够困时睡意会来，撑不住时会把她带走。没有任何钟点来决定。',
  'status.inboxEmpty': '她的收件箱是空的。',
  'status.chat': '聊天',
  'status.messages': '消息数',
  'status.first': '最早',
  'status.latest': '最近',
  'status.needs': '需求',
  'status.platforms': '平台',
  'status.noPlatforms': '没有加载任何平台适配器。',
  'status.openItems': '待处理事项',
  'status.openItemsValue': '{goals} 个进行中的目标 · {approvals} 个待审批 · {held} 条暂存消息 · {notes} 条自我模型笔记 · 主人通道：{owner}',
  'status.quotas': '配额',

  // Persona
  'persona.selfModel': '自我模型',
  'persona.selfModelNote': '她用 {tool} 记下的关于自己的认识。她的清醒会话和睡眠中的整理都能看到全部内容。',
  'persona.noNotes': '还没有笔记。',
  'persona.note': '笔记',
  'persona.section': '分区',
  'persona.text': '内容',
  'persona.since': '始于',
  'persona.changes': '变更',
  'persona.noChanges': '还没有变更。',
  'persona.change': '变更',
  'persona.when': '时间（她的时钟）',
  'persona.by': '由',
  'persona.reason': '理由',
  'persona.removed': '（已删除）',
  'persona.reverted': '已撤销',
  'persona.revert': '撤销',
  'persona.revertQuestion': '撤销 {id}？理由（会记录）：',
  'persona.revertDefault': '由主人撤销',
  'persona.revertedAs': '已撤销 {id}，记为 {as}。',
  'persona.constitution': '宪章',
  'persona.constitutionNote': '只有你能编辑它。保存时旧文本会留作 {bak}；运行中的会话在下一次请求时拿到新文本。',
  'persona.saved': '已保存（{chars} 个字符）。',
  'persona.save': '保存宪章',
  'persona.discard': '放弃修改',

  // Memory
  'memory.search': '搜索内容、来源或人',
  'memory.searchLabel': '搜索记忆',
  'memory.source': '来源',
  'memory.allSources': '全部来源',
  'memory.herOwn': '她自己的',
  'memory.status': '状态',
  'memory.all': '全部',
  'memory.searchBtn': '搜索',
  'memory.counts': '活跃 {active} · 已归档 {archived} · 已取代 {superseded} · 已结束但尚未整理的清醒 {pending}',
  'memory.noMatch': '没有匹配的记忆。',
  'memory.kind': '类型',
  'memory.strength': '强度',
  'memory.text': '内容',
  'memory.created': '创建于（她的时钟）',
  'memory.by': '由 {id} 取代',
  'memory.from': '来自 {name}',
  'memory.about': '关于 {person}',
  'memory.recalls': '回忆 {n} 次',
  'memory.forget': '遗忘',
  'memory.forgetQuestion': '永久遗忘 {id}？此操作无法撤销。',
  'memory.forgot': '已遗忘 {id}。',
  'memory.gone': '{id} 已经不存在。',
  'memory.newer': '较新',
  'memory.older': '较旧',
  'memory.range': '{from}–{to} / 共 {total}',

  // Inbox
  'inbox.approvals': '审批',
  'inbox.ownerLine': '主人通道：{line}。',
  'inbox.noOwnerLine': '无 — 需要审批的行为会被拒绝',
  'inbox.nothingWaits': '没有等待你回复的事项。',
  'inbox.request': '请求',
  'inbox.approve': '批准',
  'inbox.deny': '拒绝',
  'inbox.approved': '已批准 {id}。',
  'inbox.denied': '已拒绝 {id}。',
  'inbox.alreadyAnswered': '{id} 已被回复或已超时。',
  'inbox.outbox': '发件箱',
  'inbox.outboxNote': '她主动发起的消息会等待 {s} 秒后才发出。',
  'inbox.nothingHeld': '没有暂存的消息。',
  'inbox.to': '发给',
  'inbox.message': '消息',
  'inbox.sendsIn': '发送倒计时',
  'inbox.speaksFirst': '她先开口',
  'inbox.seconds': '{n} 秒',
  'inbox.cancelled': '已取消 {id}，不会发出。',
  'inbox.alreadySent': '{id} 已经发出。',
  'inbox.goals': '目标',
  'inbox.goalPlaceholder': '给她的目标（主人目标）',
  'inbox.newGoal': '新目标',
  'inbox.duePlaceholder': '截止：YYYY-MM-DD HH:mm',
  'inbox.due': '截止',
  'inbox.addGoal': '添加目标',
  'inbox.added': '已添加 {id}。',
  'inbox.showClosed': '显示已关闭',
  'inbox.noGoals': '没有目标。',
  'inbox.goal': '目标',
  'inbox.owner': '归属',
  'inbox.status': '状态',
  'inbox.latestNote': '最新备注',
  'inbox.close': '关闭',
  'inbox.closeQuestion': '将 {id} 标为完成并关闭？理由（可选）：',
  'inbox.closed': '已关闭 {id}。',

  // Activity
  'activity.noSession': '无会话',
  'activity.online': '{platform} 上线',
  'activity.offline': '{platform} 离线',
  'activity.failed': '失败：{error}',
  'activity.herDay': '她的日子',
  'activity.day': '日期',
  'activity.note': '时间为她的时钟；这一天的日志共有 {n} 条记录。',
  'activity.calls': '行为调用',
  'activity.allowed': '允许',
  'activity.callsLine': '{refused} 拒绝 · {approved} 批准 · {denied} 驳回',
  'activity.wakes': '唤起',
  'activity.tokens': '计费 token',
  'activity.initiatedOwner': '主动发起 · 主人',
  'activity.initiatedOwnerNote': '她发起的对话 · 主人操作',
  'activity.refusals': '按代码统计的拒绝',
  'activity.byStimulus': '按刺激统计的唤起',
  'activity.behaviors': '用到的行为',
  'activity.log': '日志',
  'activity.filter': '筛选',
  'activity.nothing': '没有记录。',
  'activity.time': '时间',
  'activity.type': '类型',
  'activity.what': '内容',
  'activity.details': '详情',
  'activity.real': '真实时间 {at}',
  'activity.newest': '显示最新的 500 条，共 {n} 条。',

  // Platforms
  'platforms.scanDone': '请用 B 站 App（登录的是她的账号）扫描下方二维码。',
  'platforms.login': '扫码登录',
  'platforms.logout': '退出登录',
  'platforms.logoutQuestion': '让她退出 B 站？她的 Cookie 会被删除。',
  'platforms.loggedOut': '已退出登录。',
  'platforms.notLoggedIn': '她本来就没有登录。',
  'platforms.scan': '请用登录着她账号的 B 站 App 扫码，然后在手机上确认。{at} 过期。',
  'platforms.note': '平台行来自已启用的适配器。',
  'platforms.none': '没有启用任何平台适配器。',

  // Settings
  'settings.disabled': '已停用',
  'settings.editable': '可编辑',
  'settings.readOnly': '只读',
  'settings.higher': '被更高层覆盖',
  'settings.higherNote': '家目录补丁或 --patch 叠加层修改了这一行。保存会写入 profile 补丁，但只要那个更高层还在加载，它仍然优先。',
  'settings.edit': '编辑',
  'settings.editNote': '这段 JSON 会替换该行在 profile 补丁（{path}）中的配置。写入前会先按该行的 schema 校验；保存后该行会重启。',
  'settings.configLabel': '{id} 配置',
  'settings.saved': '已保存 {id}；它会用新配置重启。',
  'settings.save': '保存',
  'settings.noEditor': '此 profile 未加载 DSH 的配置编辑器，因此只能在 cordis.yml 中修改设置。',
} as const

export type Key = keyof typeof zh

const en: Record<Key, string> = {
  'lang.switch': '中文',
  'lang.switchTitle': 'Switch to Chinese',

  'tab.status': 'Status',
  'tab.persona': 'Persona',
  'tab.memory': 'Memory',
  'tab.inbox': 'Goals · Approvals · Outbox',
  'tab.activity': 'Activity',
  'tab.platforms': 'Platforms',
  'tab.settings': 'Settings',

  'head.asleep': 'asleep',
  'head.awake': 'awake',
  'head.paused': 'paused',

  'common.cancel': 'Cancel',
  'common.reason': 'Reason',
  'common.loading': 'Loading…',
  'common.none': 'none',
  'common.id': 'Id',

  'format.notJson': 'Not valid JSON: {error}',
  'format.notObject': 'The config must be a JSON object.',

  'status.paused': 'paused',
  'status.running': 'running',
  'status.resume': 'Resume',
  'status.pause': 'Pause',
  'status.resumed': 'Resumed.',
  'status.pausedNote': 'Paused: nothing reaches her and every behavior is refused; her heart keeps beating.',
  'status.asleepSince': 'asleep since {since} ({why})',
  'status.tookHer': 'sleep took her',
  'status.wentToBed': 'she went to bed',
  'status.awakeSince': 'awake since {since} ({by})',
  'status.wake': 'Wake her',
  'status.woke': 'She is awake now; her waking session opens with her inbox.',
  'status.updates': 'Updates every 5 s.',
  'status.clock': 'Her clock',
  'status.realTime': 'real time',
  'status.speed': '{speed}× speed',
  'status.day': 'day {day}',
  'status.heartbeat': 'Heartbeat',
  'status.next': 'Next',
  'status.last': 'Last',
  'status.total': 'Total',
  'status.totalValue': '{beats} beats, {wakings} wakings, {sleeps} sleeps',
  'status.wakingSession': 'Waking session',
  'status.prepared': ' (prepared)',
  'status.energyMood': 'Energy and mood',
  'status.energy': 'energy',
  'status.valence': 'valence',
  'status.valenceHint': '(−1 bad … 1 good)',
  'status.arousal': 'arousal',
  'status.arousalHint': '(0 calm … 1 excited)',
  'status.budget': 'Budget ({mode})',
  'status.modeDay': 'day',
  'status.modeNight': 'night',
  'status.tokensOf': '{used} of {budget} billable tokens',
  'status.dayNight': 'day {day} · night {night}',
  'status.initiates': 'Conversations started {used} of {perDay}',
  'status.sleepInbox': 'Sleep and inbox',
  'status.pressure': 'sleep pressure',
  'status.sleepNote': 'She goes to bed when she wants; sleep comes when she is sleepy enough and takes her when she cannot stay up. No clock time decides.',
  'status.inboxEmpty': 'Her inbox is empty.',
  'status.chat': 'Chat',
  'status.messages': 'Messages',
  'status.first': 'First',
  'status.latest': 'Last',
  'status.needs': 'Needs',
  'status.platforms': 'Platforms',
  'status.noPlatforms': 'No platform adapters are loaded.',
  'status.openItems': 'Open items',
  'status.openItemsValue': '{goals} open goals · {approvals} pending approvals · {held} held messages · {notes} self-model notes · owner line: {owner}',
  'status.quotas': 'Quotas',

  'persona.selfModel': 'Self-model',
  'persona.selfModelNote': 'What she has learned about herself with {tool}. Her waking sessions and sleep\'s consolidation see all of it.',
  'persona.noNotes': 'No notes yet.',
  'persona.note': 'Note',
  'persona.section': 'Section',
  'persona.text': 'Text',
  'persona.since': 'Since',
  'persona.changes': 'Changes',
  'persona.noChanges': 'No changes yet.',
  'persona.change': 'Change',
  'persona.when': 'When (her clock)',
  'persona.by': 'By',
  'persona.reason': 'Reason',
  'persona.removed': '(removed)',
  'persona.reverted': 'reverted',
  'persona.revert': 'Revert',
  'persona.revertQuestion': 'Revert {id}? Reason (logged):',
  'persona.revertDefault': 'reverted by the owner',
  'persona.revertedAs': 'Reverted {id} as {as}.',
  'persona.constitution': 'Constitution',
  'persona.constitutionNote': 'Only you edit this. Saving keeps the previous text as {bak}; running sessions get the new text on their next request.',
  'persona.saved': 'Saved ({chars} characters).',
  'persona.save': 'Save constitution',
  'persona.discard': 'Discard changes',

  'memory.search': 'Search text, source or person',
  'memory.searchLabel': 'Search memories',
  'memory.source': 'Source',
  'memory.allSources': 'all sources',
  'memory.herOwn': 'her own',
  'memory.status': 'Status',
  'memory.all': 'all',
  'memory.searchBtn': 'Search',
  'memory.counts': 'active {active} · archived {archived} · superseded {superseded} · ended wakings not yet consolidated {pending}',
  'memory.noMatch': 'No memories match.',
  'memory.kind': 'Kind',
  'memory.strength': 'Strength',
  'memory.text': 'Text',
  'memory.created': 'Created (her clock)',
  'memory.by': 'by {id}',
  'memory.from': 'from {name}',
  'memory.about': 'about {person}',
  'memory.recalls': '{n} recalls',
  'memory.forget': 'Forget',
  'memory.forgetQuestion': 'Forget {id} for good? This cannot be undone.',
  'memory.forgot': 'Forgot {id}.',
  'memory.gone': '{id} was already gone.',
  'memory.newer': 'Newer',
  'memory.older': 'Older',
  'memory.range': '{from}–{to} of {total}',

  'inbox.approvals': 'Approvals',
  'inbox.ownerLine': 'Owner line: {line}.',
  'inbox.noOwnerLine': 'none — approval-class behaviors are refused',
  'inbox.nothingWaits': 'Nothing waits for your answer.',
  'inbox.request': 'Request',
  'inbox.approve': 'Approve',
  'inbox.deny': 'Deny',
  'inbox.approved': 'Allowed {id}.',
  'inbox.denied': 'Denied {id}.',
  'inbox.alreadyAnswered': '{id} was already answered or timed out.',
  'inbox.outbox': 'Outbox',
  'inbox.outboxNote': 'Messages she started on her own wait {s} s before they go out.',
  'inbox.nothingHeld': 'Nothing is held.',
  'inbox.to': 'To',
  'inbox.message': 'Message',
  'inbox.sendsIn': 'Sends in',
  'inbox.speaksFirst': 'she speaks first',
  'inbox.seconds': '{n} s',
  'inbox.cancelled': 'Cancelled {id}; it will not be sent.',
  'inbox.alreadySent': '{id} already went out.',
  'inbox.goals': 'Goals',
  'inbox.goalPlaceholder': 'A goal for her (owner goal)',
  'inbox.newGoal': 'New goal',
  'inbox.duePlaceholder': 'due: YYYY-MM-DD HH:mm',
  'inbox.due': 'Due',
  'inbox.addGoal': 'Add goal',
  'inbox.added': 'Added {id}.',
  'inbox.showClosed': 'show closed',
  'inbox.noGoals': 'No goals.',
  'inbox.goal': 'Goal',
  'inbox.owner': 'Owner',
  'inbox.status': 'Status',
  'inbox.latestNote': 'Latest note',
  'inbox.close': 'Close',
  'inbox.closeQuestion': 'Close {id} as done? Reason (optional):',
  'inbox.closed': 'Closed {id}.',

  'activity.noSession': 'no session',
  'activity.online': '{platform} online',
  'activity.offline': '{platform} offline',
  'activity.failed': 'failed: {error}',
  'activity.herDay': 'Her day',
  'activity.day': 'Day',
  'activity.note': 'Times are her clock; the log has {n} records for this day.',
  'activity.calls': 'Behavior calls',
  'activity.allowed': 'allowed',
  'activity.callsLine': '{refused} refused · {approved} approved · {denied} denied',
  'activity.wakes': 'Wakes',
  'activity.tokens': 'Billable tokens',
  'activity.initiatedOwner': 'Initiated · owner',
  'activity.initiatedOwnerNote': 'conversations she started · owner actions',
  'activity.refusals': 'Refusals by code',
  'activity.byStimulus': 'Wakes by stimulus',
  'activity.behaviors': 'Behaviors used',
  'activity.log': 'Log',
  'activity.filter': 'Filter',
  'activity.nothing': 'Nothing recorded.',
  'activity.time': 'Time',
  'activity.type': 'Type',
  'activity.what': 'What',
  'activity.details': 'Details',
  'activity.real': 'real {at}',
  'activity.newest': 'Showing the newest 500 of {n}.',

  'platforms.scanDone': 'Scan the QR below with the Bilibili app, logged in to HER account.',
  'platforms.login': 'Log in with QR',
  'platforms.logout': 'Log out',
  'platforms.logoutQuestion': 'Log her out of Bilibili? Her cookies are deleted.',
  'platforms.loggedOut': 'Logged out.',
  'platforms.notLoggedIn': 'She was not logged in.',
  'platforms.scan': 'Scan with the Bilibili app, logged in to her account, then confirm on the phone. Expires at {at}.',
  'platforms.note': 'Platform rows come from enabled adapters.',
  'platforms.none': 'No platform adapters are enabled.',

  'settings.disabled': 'disabled',
  'settings.editable': 'editable',
  'settings.readOnly': 'read-only',
  'settings.higher': 'overridden by a higher layer',
  'settings.higherNote': 'A home patch or a --patch overlay changes this row. A save writes the profile patch, but that higher layer still wins while it is loaded.',
  'settings.edit': 'Edit',
  'settings.editNote': 'This JSON replaces the row\'s config in the profile patch ({path}). It is checked against the row\'s schema before anything is written; the row restarts after a save.',
  'settings.configLabel': '{id} config',
  'settings.saved': 'Saved {id}; it restarts with the new config.',
  'settings.save': 'Save',
  'settings.noEditor': 'DSH\'s config editor is not loaded in this profile, so settings are only editable in cordis.yml.',
}

/** Display names of values the Host sends as plain words (statuses, decisions, kinds). */
const zhWords: Record<string, string> = {
  // health
  ok: '正常', warn: '警告', down: '断开', off: '关闭',
  // gate decisions and log types
  allowed: '允许', refused: '拒绝', approved: '批准', denied: '驳回',
  gate: '闸门', wake: '唤起', owner: '主人', platform: '平台', all: '全部',
  // goals, memory, self-model
  open: '进行中', closed: '已关闭', done: '已完成', her: '她',
  active: '活跃', archived: '已归档', superseded: '已取代',
  add: '新增', change: '修改', remove: '删除', revert: '撤销',
}

const dictionaries: Record<Lang, Record<Key, string>> = { zh, en }

const STORAGE_KEY = 'anima-page.lang'

function initialLang(): Lang {
  try {
    const saved = typeof window === 'undefined' ? null : window.localStorage.getItem(STORAGE_KEY)
    if (saved === 'zh' || saved === 'en') return saved
  } catch {
    // Storage may be unavailable; use the default.
  }
  return 'zh'
}

let current: Lang = initialLang()

/** The page's current language. */
export function lang(): Lang {
  return current
}

/**
 * Change the page's language and remember it. Callers re-render the page.
 * @param next - the new language.
 */
export function setLang(next: Lang): void {
  current = next
  try { window.localStorage.setItem(STORAGE_KEY, next) } catch { /* not persisted */ }
}

/**
 * Translate one key, filling `{name}` placeholders.
 * @param key - copy key.
 * @param vars - placeholder values.
 */
export function t(key: Key, vars: Readonly<Record<string, string | number>> = {}): string {
  return dictionaries[current][key].replace(/\{(\w+)\}/g, (match, name: string) => name in vars ? String(vars[name]) : match)
}

/**
 * Display a plain word from the Host (a status, decision or kind); unknown words stay as they are.
 * @param value - the Host's word.
 */
export function word(value: string): string {
  return current === 'zh' ? zhWords[value] ?? value : value
}
