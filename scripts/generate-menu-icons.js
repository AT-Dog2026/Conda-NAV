// ═══════════════════════════════════════════════════════
// 生成托盘右键菜单图标 PNG
// 一次性运行：node scripts/generate-menu-icons.js
// 输出到 electron/assets/icons/menu/{name}-{light|dark}-{1x|2x}.png
// ═══════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const OUT_DIR = path.join(__dirname, '..', 'electron', 'assets', 'icons', 'menu');

// 颜色配置
const COLORS = {
  light: {
    // 浅色菜单背景下用深色图标
    default: '#4B5563',         // Gray 600
    active: '#16A34A',          // Green 600（状态激活）
    primary: '#4CAF50',         // Green 500（品牌色）
    danger: '#DC2626',          // Red 600（退出）
    info: '#2563EB',            // Blue 600（切换/项目）
    warning: '#D97706',         // Amber 600（主题切换）
  },
  dark: {
    // 深色菜单背景下用浅色图标
    default: '#aaaaaa',
    active: '#4ADE80',
    primary: '#4CAF50',
    danger: '#F87171',
    info: '#60A5FA',
    warning: '#FBBF24',
  },
};

// 单色 SVG 图标库（16x16 viewBox）
// 使用 currentColor 占位，渲染时替换为实际颜色
const ICONS = {
  'window': `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2.5" y="3" width="11" height="10" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 6 H13.5" stroke="currentColor" stroke-width="1.3"/><circle cx="4" cy="4.5" r="0.4" fill="currentColor"/><circle cx="5.5" cy="4.5" r="0.4" fill="currentColor"/></svg>`,

  'widget': `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.2"/><rect x="5" y="5" width="6" height="6" rx="1" fill="currentColor" opacity="0.6"/></svg>`,

  'dot-circle': `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.2" opacity="0.4"/><circle cx="8" cy="8" r="2" fill="currentColor" opacity="0.4"/></svg>`,

  'dot-circle-active': `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="2.5" fill="currentColor"/></svg>`,

  'swap': `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 5 H12 M9 2 L12 5 L9 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M13 11 H4 M7 8 L4 11 L7 14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`,

  'terminal': `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M4 7 L6 9 L4 11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M8 11 H12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`,

  'folder-terminal': `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 5 V12 a1 1 0 0 0 1 1 H13 a1 1 0 0 0 1 -1 V6 a1 1 0 0 0 -1 -1 H8 L6 3 H3 a1 1 0 0 0 -1 1 Z" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/><path d="M5.5 8.5 L7 9.8 L5.5 11 M9 11 H11" stroke="currentColor" stroke-width="0.9" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`,

  'folder': `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 5 V12 a1 1 0 0 0 1 1 H13 a1 1 0 0 0 1 -1 V6 a1 1 0 0 0 -1 -1 H8 L6 3 H3 a1 1 0 0 0 -1 1 Z" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/></svg>`,

  'copy': `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="9" height="9" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M11 5 V3 a1 1 0 0 0 -1 -1 H3 a1 1 0 0 0 -1 1 V11 a1 1 0 0 0 1 1 H5" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/></svg>`,

  'plus': `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.2"/><path d="M8 5 V11 M5 8 H11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,

  'refresh': `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M13 8 A5 5 0 1 1 11 4.5" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/><path d="M13 2 V5 H10" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,

  'project': `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 13 V4 L8 2 L13 4 V13 L8 11 Z" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/><path d="M8 2 V11" stroke="currentColor" stroke-width="1" opacity="0.6"/></svg>`,

  'settings': `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M8 1 V3 M8 13 V15 M1 8 H3 M13 8 H15 M3.5 3.5 L4.9 4.9 M11.1 11.1 L12.5 12.5 M12.5 3.5 L11.1 4.9 M4.9 11.1 L3.5 12.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`,

  'sun-moon': `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M8 1 V3 M8 13 V15 M1 8 H3 M13 8 H15 M3 3 L4.5 4.5 M11.5 11.5 L13 13 M13 3 L11.5 4.5 M4.5 11.5 L3 13" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>`,

  'close': `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.2"/><path d="M5.5 5.5 L10.5 10.5 M10.5 5.5 L5.5 10.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,

  'chevron': `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M5 6 L8 9 L11 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`,
};

// 每个图标的语义颜色（决定用 COLORS 里的哪个键）
const ICON_COLOR_ROLE = {
  'dot-circle': 'default',
  'dot-circle-active': 'active',
  'window': 'default',
  'widget': 'default',
  'swap': 'info',
  'terminal': 'primary',
  'folder-terminal': 'primary',
  'folder': 'default',
  'copy': 'default',
  'plus': 'primary',
  'refresh': 'info',
  'project': 'info',
  'settings': 'default',
  'sun-moon': 'warning',
  'close': 'danger',
  'chevron': 'default',
};

async function renderIcon(name, svg, color, size, outPath) {
  const colored = svg.replace(/currentColor/g, color);
  await sharp(Buffer.from(colored))
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(outPath);
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }
  const sizes = [{ name: '1x', px: 16 }, { name: '2x', px: 32 }];
  let count = 0;
  for (const [iconName, svg] of Object.entries(ICONS)) {
    const role = ICON_COLOR_ROLE[iconName] || 'default';
    for (const themeKey of ['light', 'dark']) {
      const color = COLORS[themeKey][role] || COLORS[themeKey].default;
      for (const { name: suffix, px } of sizes) {
        const outPath = path.join(OUT_DIR, `${iconName}-${themeKey}-${suffix}.png`);
        await renderIcon(iconName, svg, color, px, outPath);
        count++;
      }
    }
  }
  console.log(`✓ 已生成 ${count} 个图标到 ${OUT_DIR}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
