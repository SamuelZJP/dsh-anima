// Fixed cast and settings of the Phase 8 scripted reliability check (DESIGN §14, roadmap item 8).
// Everyone here is fake: the check runs the real QQ adapter against an in-process OneBot v11
// server (check.mjs), so no message ever reaches a real account.

export const ACCOUNT = '10001'
export const OWNER = { id: '20002', name: 'Sam' }
export const PORT = 3913

const NAMES = ['小明', '小红', '阿杰', '小雨', '大伟', '佳佳', '老王', '小美', '阿强', '晓晓',
  '小林', '阿花', '浩然', '思思', '小凯', '雯雯', '阿飞', '小胖', '琪琪', '阿龙',
  '小鹿', '安安', '小周', '甜甜', '阿宇', '小静', '大山', '果果', '阿明', '小雪']

/** 30 private friends, each a fresh conversation session. */
export const USERS = NAMES.map((name, index) => ({ id: String(30001 + index), name }))

/** Groups; members are the users. */
export const GROUPS = [
  { id: '40001', name: '火锅小分队' },
  { id: '40002', name: '读书会' },
  { id: '40003', name: '游戏开黑' },
  { id: '40004', name: '同学群' },
]

export const CHECK_DIR = '~/.anima/check-p8d'
export const CHARACTER = 'anima-check-p8d'
