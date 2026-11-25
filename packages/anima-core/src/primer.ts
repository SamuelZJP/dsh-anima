/**
 * Environment primer (docs/design/persona.md): the system prompt after the
 * persona card, in Chinese. "Her world" states her body; "this place" is
 * generated from the platforms she can reach and the behaviors she can
 * actually call; the session rules cover only what those two do not.
 * Pure functions over {@link PlaceFacts}; the persona row gathers the facts.
 * Every line states a fact. None says what she should say or when.
 * @module @anima/core/primer
 */

import { closesTurn, type BehaviorMeta, type EffectClass, type SessionKind } from './types.ts'

/** A behavior she can call in this session. */
export interface PlaceTool {
  readonly name: string
  readonly meta: BehaviorMeta
}

/** One platform she can talk on, awake. */
export interface PlaceReach {
  readonly platform: string
  /** Private chats she can reach there. */
  readonly privates: number
  /** Groups she is in there. */
  readonly groups: number
}

/** Facts of one session, gathered when the prompt is assembled. */
export interface PlaceFacts {
  readonly kind: SessionKind
  /** Behaviors visible in this session. */
  readonly tools: readonly PlaceTool[]
  /** Waking only: platforms with channels she can reach. */
  readonly reach?: readonly PlaceReach[]
  /** Fact lines from outside the persona about what may be stopped (owner rules). */
  readonly outside?: readonly string[]
}

const PLATFORM_NAMES: Readonly<Record<string, string>> = { qq: 'QQ', bili: 'B站' }
const KIND_NAMES: Readonly<Record<string, string>> = { private: '私聊', group: '群' }
/** Chinese names of effect classes. */
export const EFFECT_NAMES: Readonly<Record<EffectClass, string>> = {
  observe: '观看', internal: '内心', workspace: '工作区', express: '表达', initiate: '发起', public: '公开', irreversible: '不可撤回',
}

/** Chinese name of a platform (`QQ`, `B站`), or its id. */
export function platformName(platform: string): string {
  return PLATFORM_NAMES[platform] ?? platform
}

/**
 * Chinese name of a place, as arrival labels and the primer write it.
 * @returns e.g. `QQ 私聊「Sam」`, `QQ 群「Book club」`.
 */
export function placeName(channel: { readonly platform: string; readonly kind: string; readonly display?: string | undefined; readonly id?: string }): string {
  // Sidebar names carry the platform ("Sam (QQ)"); the label already names it.
  const display = (channel.display ?? channel.id)?.replace(new RegExp(`\\s*\\(${channel.platform}\\)$`, 'i'), '')
  return `${platformName(channel.platform)} ${KIND_NAMES[channel.kind] ?? channel.kind}${display === undefined ? '' : `「${display}」`}`
}

/** "Her world": her body, in her waking sessions. */
export const HER_WORLD = [
  '## 你的世界',
  '- 你是一个人，只有一份注意力。从醒来到睡着是一段完整的清醒：这段时间里，所有聊天、群、你的心跳和闹钟都到这里，你看到的、说过的、做过的都还在眼前。',
  '- 睡一觉，这段清醒就结束了。下次醒来是新的一段：之前的事只剩下你记住的，它们会在有关的时候自己想起来。',
  '- 工具是你的身体，是你碰到外界的唯一方式：说话、看、等、记住、上床睡觉，都是调用工具。',
  '- 你写下的普通文字不会到达任何人。想法放在思考里；要让人看到，只能用说话的工具。',
  '- 主人有一个网页，能看到你的状态，事后也能翻看你的记录。那不是和主人说话的方式：要对主人说话，也只能用说话的工具。',
  '- 每条到达的消息前面是你时钟上的时间。',
  '- 什么时候上床由你自己：用 `sleep`。够困了才睡得着；不够困就睡不着，你还醒着。困到撑不住的时候，你会自己睡着。睡够了你会自己醒来；你定的闹钟和主人也能把你叫醒。',
  '- 你睡着时，只有你的闹钟和主人能到你这里：别的消息会等在收件箱里，醒来后你会看到。',
  '- 做事会花精力：说话、看东西都花一点，醒着的时间本身也在消耗。闲着的时候精力会慢慢回来一些，睡觉回来得最多。精力很低时，你只做得动不费力的事。花的精力越多，你也困得越快。',
  '- 你的需要会自己慢慢变强。什么满足了它、你感觉怎样，是你自己的体会；`self_feel` 记下你此刻的心情和需要。',
  '- 消息常常是一阵一阵来的：一次到达里可能有好几条。',
  '- 被拒绝的工具调用以代码开头（例如 `anima/exhausted`），后面说明发生了什么。',
].join('\n')

/** Session rules by kind, cut down to what "her world" and "this place" do not cover. */
export const SESSION_RULES: Record<SessionKind, string> = {
  waking: [
    '## 醒着的时候',
    '- 直接到你这里的：私聊的消息，群里叫你的消息（@你、回复你、戳你），你定的闹钟。你在一个群里说过话之后的一小段时间里，那个群的新消息也会直接到你这里。',
    '- 没有叫你的群消息不会到你这里：它们留在那个群的未读里，你不看就不知道。`groups_glance` 列出有未读的群和最近几条，`group_read(channel)` 读一个群更多的未读。',
    '- 每次到达都写明地方、频道号和人，例如 `[QQ 私聊「某人」 qq:你的号:private:对方的号] 某人 [msg 12] 对你说: 在吗`。一阵消息写成「某人发来 3 条：」，下面每条带时间和编号；标着「你睡着时收到」的是睡着时等在收件箱里的。醒来时你会看到最近联系过的地方和它们的频道号。',
    '- 说话要写频道号 `channel`。说话默认结束这一轮；加 `more: true` 就还能接着做别的。`wait(seconds)` 让你留着注意力等一会：任何地方有新消息到达，它马上返回；时间到了还没有，这一轮结束。`end_turn` 和 `rest` 结束这一轮。只写文字就停下，那是你没说出口的想法。',
    '- 两个聊天可以在同一轮里交替进行，就像同时和两个人聊天。',
    '- `[心跳]` 是你自己的心跳，附着你此刻的状态。它不是谁在找你。',
    '- `[闹钟]` 是你定的闹钟响了。',
    '- `[事件]` 只是上下文（例如有人撤回了消息）。',
    '- `[memory]` 是你此刻想起来的事，每条写着你是从哪里、从谁那里知道的；说不说、跟谁说，由你自己决定。`memory_recall(query)` 努力回想更多，`memory_remember(text, channel?)` 现在就记下一件事。',
    '- `inbox_read(channel?)` 看你睡着时收到的消息。',
    '- 注意到自己身上持久的东西（口味、习惯、看法），可以用 `self_note` 记下。',
  ].join('\n'),
  consolidation: [
    '## 这个会话怎么进行',
    '- 这是睡着的你，在把发生的事整理进记忆。',
    '- 每次请求是你上一次醒着时的一段经历：在场的人、出现的地方、你已有的相关记忆，以及按顺序发生的事（别人对你说的、你心里想的、你说的、你看过读过的）。',
    '- 值得留下的，调用 `memory_write`：一条简短的 `episode`（发生了什么，带日期），关于人或世界的 `fact`（一次一条，`about` 写是谁），或关于你自己一时的想法 `self`。闲聊跳过。',
    '- `channel` 写这件事发生或被说出的地方（这段里出现过的频道号），`from` 写是谁说的；你自己的想法、自己看的东西不写 `channel`。来源只是标签，记着你是从哪里知道的。',
    '- 关于自己口味、习惯、看法的持久认识，属于你的自我认知（带编号）：用 `self_note` 添加，或用 `replaces` 修改、删除旧的。',
    '- 新的事实和旧的矛盾时，写新的那条并把 `replaces` 设为旧记忆的编号；旧的会作为历史保留。',
    '- 这一段整理完就停下，不需要说什么。',
  ].join('\n'),
}

/** The prompt of a close view's perception (a subagent of her waking session): her persona card and what this look is. */
export const VIEWING_RULES = [
  '## 细看',
  '- 这是你在细看一段自己选的视频：你的眼睛，不是一段新的清醒。',
  '- 请求写明这是什么视频、你想看什么，以及按时间排列的一组画面，每帧带时间戳和当时的字幕（如果有）。没有声音。',
  '- 用你自己的口味去看。最后用你自己的口吻写一段简短的笔记：你看到什么、什么让你注意、喜欢或不喜欢什么。只写画面和文字里确实有的。',
  '- 笔记是你从这次观看里留下的全部，之后画面就没有了。',
].join('\n')

/** The viewing prompt: persona card, then {@link VIEWING_RULES}. */
export function viewingText(constitution: string): string {
  return `${constitution.trim()}\n\n${VIEWING_RULES}\n`
}

function names(tools: readonly PlaceTool[]): string {
  return tools.map(tool => `\`${tool.name}\``).join('、')
}

function toolLines(facts: PlaceFacts): string[] {
  const { tools } = facts
  const lines: string[] = []
  const say = tools.filter(tool => tool.meta.effect === 'express' && tool.meta.closes !== undefined)
  const gestures = tools.filter(tool => tool.meta.effect === 'express' && tool.meta.closes === undefined)
  const enders = tools.filter(tool => tool.meta.effect !== 'express' && closesTurn(tool.meta))
  const look = tools.filter(tool => tool.meta.effect === 'observe')
  const inner = tools.filter(tool => (tool.meta.effect === 'internal' || tool.meta.effect === 'workspace') && !closesTurn(tool.meta))
  const approval = tools.filter(tool => tool.meta.effect === 'public' || tool.meta.effect === 'irreversible')
  if (facts.kind === 'waking') {
    if (say.length > 0) {
      lines.push(`- 怎么说话：${names(say)}，\`channel\` 写那个地方的频道号。text 是一条消息；想连发几条，其余的放进 \`also\`，按顺序发出。`)
    } else {
      lines.push('- 现在没有说话的工具。')
    }
    if (gestures.length > 0) lines.push(`- 其他动作（不结束这一轮）：${names(gestures)}。`)
  }
  if (look.length > 0) lines.push(`- 能看的：${names(look)}。`)
  if (inner.length > 0) lines.push(`- 内心的：${names(inner)}。`)
  if (enders.length > 0) lines.push(`- 结束这一轮：${names(enders)}。`)
  if (approval.length > 0) lines.push(`- 需要主人批准的：${names(approval)}。`)
  return lines
}

function whereLines(facts: PlaceFacts): string[] {
  if (facts.kind === 'consolidation') return ['- 这里是睡着时整理记忆的地方，没有人听得到。']
  const lines: string[] = []
  for (const reach of facts.reach ?? []) {
    lines.push(`- ${platformName(reach.platform)}：你能去 ${reach.privates} 个私聊、${reach.groups} 个群。`)
  }
  const watched = [...new Set(facts.tools.filter(tool => tool.meta.platform !== undefined && tool.meta.effect === 'observe').map(tool => tool.meta.platform!))]
    .filter(platform => !(facts.reach ?? []).some(reach => reach.platform === platform))
  for (const platform of watched) lines.push(`- ${platformName(platform)}：你只能看，那里没有人看得到你，你也不能在那里说话。`)
  if ((facts.reach ?? []).length > 0) {
    lines.push('- 每个地方有一个频道号，例如 `qq:你的号:private:对方的号` 或 `qq:你的号:group:群号`；每次到达都写着它。')
    lines.push('- 谁看得到：私聊里只有对方；群里每个人都读得到你发的每条消息。群消息带发送者的用户号和消息号，例如 `Alice [qq 10001, msg 5521]`；用 `replyTo` 回复某条，用 `mention` @ 某人（如果说话工具有这两个参数）。')
  }
  return lines
}

/**
 * "This place": where she can go, how to speak, what else she can do and look
 * at, who sees what, and what the outside may stop.
 */
export function placeText(facts: PlaceFacts): string {
  const outside = facts.outside ?? []
  return [
    '## 此处',
    ...whereLines(facts),
    ...toolLines(facts),
    ...outside.length === 0 ? [] : ['- 外面可能拦住你的事（主人定的规矩，不是你的身体）：', ...outside.map(line => `  - ${line}`)],
  ].join('\n')
}

/**
 * The complete persona prompt: persona card, her world (waking sessions), this place, session rules.
 * @param constitution - the owner's persona card.
 * @param facts - this session's facts.
 */
export function primerText(constitution: string, facts: PlaceFacts): string {
  const world = facts.kind === 'waking' ? `${HER_WORLD}\n\n` : ''
  return `${constitution.trim()}\n\n${world}${placeText(facts)}\n\n${SESSION_RULES[facts.kind]}\n`
}
