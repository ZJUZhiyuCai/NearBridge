import { common, Configuration, ConfigurationConstant, EnvironmentCallback, AbilityConstant } from '@kit.AbilityKit';
import { resourceManager } from '@kit.LocalizationKit';

/**
 * NearBridge 设计语言（手机端）
 * 系统蓝为主色，成功也用蓝色；不使用任何绿色。颜色为 #AARRGGBB。
 */
export interface Palette {
  bg: string;
  card: string;
  fill: string;
  text: string;
  text2: string;
  text3: string;
  separator: string;
  tint: string;
  tintSoft: string;
  warn: string;
  warnSoft: string;
  danger: string;
  shadow: string;
}

export const LIGHT: Palette = {
  bg: '#F2F2F7',
  card: '#FFFFFF',
  fill: '#1F767680',
  text: '#000000',
  text2: '#993C3C43',
  text3: '#4D3C3C43',
  separator: '#4A3C3C43',
  tint: '#007AFF',
  tintSoft: '#E5F0FF',
  warn: '#FF9500',
  warnSoft: '#FFF3E0',
  danger: '#FF3B30',
  shadow: '#1A000000'
};

export const DARK: Palette = {
  bg: '#000000',
  card: '#1C1C1E',
  fill: '#3D767680',
  text: '#FFFFFF',
  text2: '#99EBEBF5',
  text3: '#4DEBEBF5',
  separator: '#99545458',
  tint: '#0A84FF',
  tintSoft: '#0F2A4A',
  warn: '#FF9F0A',
  warnSoft: '#3A2A10',
  danger: '#FF453A',
  shadow: '#00000000'
};

export const TINT_TOP: string = '#3D94FF';
export const TINT_BOTTOM: string = '#0A6CFF';

export function palette(dark: boolean): Palette {
  return dark ? DARK : LIGHT;
}

// ---------- 深色模式：写入 AppStorage 'nbDark' ----------

const themeWatcher: EnvironmentCallback = {
  onConfigurationUpdated: (config: Configuration): void => {
    if (config.colorMode !== undefined) {
      AppStorage.setOrCreate<boolean>('nbDark', config.colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK);
    }
  },

  onMemoryLevel: (_level: AbilityConstant.MemoryLevel): void => {
  }
};

let watcherId: number = -1;

export function watchTheme(context: common.Context): void {
  try {
    const mode = context.resourceManager.getConfigurationSync().colorMode;
    AppStorage.setOrCreate<boolean>('nbDark', mode === resourceManager.ColorMode.DARK);
  } catch (e) {
  }
  if (watcherId >= 0) {
    return;
  }
  try {
    watcherId = context.getApplicationContext().on('environment', themeWatcher);
  } catch (e) {
  }
}

// ---------- 快捷指令色板与图标（与 Mac 端 BridgeDesign.swift 一致） ----------

export interface Tone {
  top: string;
  bottom: string;
}

const TONES: Tone[] = [
  { top: '#4DA3FF', bottom: '#0A6CFF' },
  { top: '#7D7AFF', bottom: '#4C3FE0' },
  { top: '#C77DFF', bottom: '#8A3FD9' },
  { top: '#FF7EB3', bottom: '#F0407A' },
  { top: '#FF8A70', bottom: '#EC4A3B' },
  { top: '#FFB35C', bottom: '#FF7A00' },
  { top: '#6CCBFF', bottom: '#1C8FE8' },
  { top: '#A3A9B5', bottom: '#5F6673' }
];

export function stableHash(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) % 1000003;
  }
  return hash;
}

export function toneFor(key: string): Tone {
  return TONES[stableHash(key) % TONES.length];
}

interface GlyphRule {
  key: string;
  words: string[];
}

const GLYPH_RULES: GlyphRule[] = [
  { key: 'camera', words: ['截图', '截屏', '拍', '相机', '照片'] },
  { key: 'music', words: ['音乐', '播放', '歌', '音量', '静音', '声音'] },
  { key: 'moon', words: ['睡眠', '休眠', '勿扰', '专注', '晚安', '夜'] },
  { key: 'lock', words: ['锁', '离开'] },
  { key: 'doc', words: ['文档', '笔记', '备忘', '记录', '写'] },
  { key: 'open', words: ['打开', '网页', '浏览', '链接', '启动'] },
  { key: 'clipboard', words: ['剪贴板', '复制', '粘贴'] },
  { key: 'download', words: ['下载', '保存', '备份'] },
  { key: 'sun', words: ['亮度', '灯', '屏幕', '显示器'] }
];

export function glyphFor(name: string): string {
  for (const rule of GLYPH_RULES) {
    for (const word of rule.words) {
      if (name.indexOf(word) >= 0) {
        return rule.key;
      }
    }
  }
  return 'bolt';
}

/** 自绘 SVG 图标（resources/base/media/nb_*.svg），用 fillColor 着色。 */
export function glyph(key: string): Resource {
  switch (key) {
    case 'photo': return $r('app.media.nb_photo');
    case 'doc': return $r('app.media.nb_doc');
    case 'up': return $r('app.media.nb_up');
    case 'down': return $r('app.media.nb_down');
    case 'more': return $r('app.media.nb_more');
    case 'camera': return $r('app.media.nb_camera');
    case 'music': return $r('app.media.nb_music');
    case 'moon': return $r('app.media.nb_moon');
    case 'lock': return $r('app.media.nb_lock');
    case 'open': return $r('app.media.nb_open');
    case 'clipboard': return $r('app.media.nb_clipboard');
    case 'download': return $r('app.media.nb_download');
    case 'sun': return $r('app.media.nb_sun');
    case 'laptop': return $r('app.media.nb_laptop');
    case 'check': return $r('app.media.nb_check');
    case 'close': return $r('app.media.nb_close');
    case 'pause': return $r('app.media.nb_pause');
    case 'scan': return $r('app.media.nb_scan');
    case 'bluetooth': return $r('app.media.nb_bluetooth');
    case 'wifi': return $r('app.media.nb_wifi');
    case 'bubble': return $r('app.media.nb_bubble');
    case 'chevron': return $r('app.media.nb_chevron');
    case 'copy': return $r('app.media.nb_copy');
    default: return $r('app.media.nb_bolt');
  }
}

// ---------- 文本与格式 ----------

const IMAGE_EXT: string[] = ['jpg', 'jpeg', 'png', 'heic', 'heif', 'gif', 'webp', 'bmp'];

export function isImageName(name?: string): boolean {
  if (!name) {
    return false;
  }
  const dot = name.lastIndexOf('.');
  if (dot < 0) {
    return false;
  }
  return IMAGE_EXT.indexOf(name.substring(dot + 1).toLowerCase()) >= 0;
}

export function isLink(text?: string): boolean {
  if (!text) {
    return false;
  }
  const value = text.trim().toLowerCase();
  if (!value.startsWith('http://') && !value.startsWith('https://')) {
    return false;
  }
  return value.indexOf(' ') < 0 && value.indexOf('\n') < 0;
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

/** 今天 14:32 / 昨天 14:32 / 10月24日 / 2025/10/24 */
export function timeLabel(raw: string): string {
  const date = new Date(raw);
  const time = date.getTime();
  if (Number.isNaN(time)) {
    return '';
  }
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (time >= startOfToday) {
    return clock;
  }
  if (time >= startOfToday - 86400000) {
    return `昨天 ${clock}`;
  }
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

/** 与 macOS ByteCountFormatter(.file) 一致，按 1000 进位。 */
export function sizeLabel(size?: number): string {
  if (size === undefined || size < 0) {
    return '';
  }
  if (size < 1000) {
    return `${size} B`;
  }
  const units: string[] = ['KB', 'MB', 'GB', 'TB'];
  let value = size / 1000;
  let index = 0;
  while (value >= 1000 && index < units.length - 1) {
    value = value / 1000;
    index++;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}
