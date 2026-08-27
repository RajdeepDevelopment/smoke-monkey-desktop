import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: ['class'],
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-inter)', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['var(--font-jetbrains)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
          hover: 'hsl(var(--primary-hover))',
          subtle: 'hsl(var(--primary-subtle))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
          hover: 'hsl(var(--accent-hover))',
          subtle: 'hsl(var(--accent-subtle))',
        },
        success: {
          DEFAULT: 'hsl(var(--success))',
          subtle: 'hsl(var(--success-subtle))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          subtle: 'hsl(var(--warning-subtle))',
        },
        error: {
          DEFAULT: 'hsl(var(--destructive))',
          subtle: 'hsl(var(--error-subtle))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        // Smoke Monkey layered dark surfaces (kept for the app's own surfaces)
        bg: {
          DEFAULT: 'hsl(var(--bg))',
          elevated: 'hsl(var(--bg-elevated))',
        },
        surface: {
          950: 'hsl(var(--surface-950))',
          900: 'hsl(var(--surface-900))',
          850: 'hsl(var(--surface-850))',
          800: 'hsl(var(--surface-800))',
          700: 'hsl(var(--surface-700))',
          600: 'hsl(var(--surface-600))',
        },
        ink: {
          primary: 'hsl(var(--ink-primary))',
          secondary: 'hsl(var(--ink-secondary))',
          muted: 'hsl(var(--ink-muted))',
        },
      },
      borderRadius: {
        card: 'var(--radius-card)',
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      boxShadow: {
        glow: '0 0 0 1px hsl(var(--ring) / 0.35), 0 0 24px -6px hsl(var(--ring) / 0.35)',
        'glow-strong': '0 0 0 1px hsl(var(--ring) / 0.5), 0 0 36px -6px hsl(var(--ring) / 0.5)',
        'card-lift':
          '0 4px 12px -2px rgba(0, 0, 0, 0.45), 0 1px 3px rgba(0, 0, 0, 0.4)',
        'soft-panel': 'inset 0 1px 0 0 rgba(255, 255, 255, 0.03)',
      },
      backgroundImage: {
        'primary-glow':
          'radial-gradient(120% 120% at 50% 0%, hsl(var(--primary-subtle)) 0%, transparent 55%)',
        'app-aurora':
          'radial-gradient(90% 60% at 50% -10%, hsl(var(--primary-subtle)) 0%, transparent 60%), radial-gradient(60% 40% at 90% 0%, hsl(var(--accent)/0.06) 0%, transparent 55%)',
        'mesh-fade':
          'linear-gradient(180deg, hsl(var(--surface-900)/0.6) 0%, transparent 100%)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-600px 0' },
          '100%': { backgroundPosition: '600px 0' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.55' },
        },
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        shimmer: 'shimmer 1.6s linear infinite',
        'pulse-soft': 'pulse-soft 2s ease-in-out infinite',
        'fade-in': 'fade-in 0.3s ease-out both',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
