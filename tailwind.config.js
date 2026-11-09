/**
 * Tailwind 配置
 * - 本地打包（css/tailwind.css），比赛现场无外网也能正常展示，不依赖 CDN
 * - 主题色通过 CSS 变量驱动，见 css/style.css 顶部的 :root / html.dark
 */
module.exports = {
  content: ['./index.html', './js/**/*.js'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Microsoft YaHei',
          'PingFang SC',
          'Noto Sans SC',
          'Helvetica Neue',
          'sans-serif'
        ],
        mono: ['JetBrains Mono', 'SFMono-Regular', 'Consolas', 'Menlo', 'monospace']
      },
      maxWidth: {
        shell: '1560px'
      }
    }
  },
  plugins: []
};
