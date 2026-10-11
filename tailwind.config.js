/** @type {import('tailwindcss').Config} */
const defaultTheme = require('tailwindcss/defaultTheme')

module.exports = {
  darkMode: 'class',
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"SF Pro Text"',
          '"Segoe UI"',
          'Roboto',
          'system-ui',
          ...defaultTheme.fontFamily.sans
        ],
        mono: [
          '"SF Mono"',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Consolas',
          ...defaultTheme.fontFamily.mono
        ],
        // HUD / data plates (Martian Mono when bundled, mono fallback).
        hud: ['"Martian Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        // Wordmark + stage titles only (Michroma when bundled).
        display: ['"Michroma"', '"Eurostile"', 'ui-sans-serif', 'system-ui', 'sans-serif']
      },
      colors: {
        // Signature accent — runway amber
        accent: {
          DEFAULT: '#f59e0b',
          soft: '#fbbf24',
          dim: '#b45309'
        },
        // Space chrome tokens (mission-control instrument panel).
        void: '#090B10',
        hull: '#12161E',
        hairline: '#2A3442',
        paper: '#EDE7DA',
        muted: '#8B94A3',
        ember: '#FF8A3D'
      },
      boxShadow: {
        tile: '0 1px 2px rgb(0 0 0 / 0.06), 0 1px 3px rgb(0 0 0 / 0.1)',
        'tile-hover': '0 4px 12px rgb(0 0 0 / 0.12), 0 2px 4px rgb(0 0 0 / 0.08)',
        menu: '0 10px 32px rgb(0 0 0 / 0.18), 0 2px 8px rgb(0 0 0 / 0.12)',
        overlay: '0 20px 60px rgb(0 0 0 / 0.35), 0 8px 20px rgb(0 0 0 / 0.25)'
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' }
        },
        'pop-in': {
          from: { opacity: '0', transform: 'scale(0.97) translateY(4px)' },
          to: { opacity: '1', transform: 'scale(1) translateY(0)' }
        },
        shimmer: {
          '0%, 100%': { opacity: '0.4' },
          '50%': { opacity: '1' }
        }
      },
      animation: {
        'fade-in': 'fade-in 150ms ease-out',
        'pop-in': 'pop-in 160ms cubic-bezier(0.2, 0.9, 0.3, 1)',
        shimmer: 'shimmer 1.6s ease-in-out infinite'
      }
    }
  },
  plugins: []
}
