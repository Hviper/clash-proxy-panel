/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    './public/**/*.html',
    './public/**/*.js'
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#f0f9ff',
          400: '#38bdf8',
          500: '#0ea5e9',
          600: '#0284c7',
        },
        dark: {
          900: '#0b0f19',
          850: '#0f172a',
          800: '#1e293b',
          750: '#283548',
          700: '#334155',
          600: '#475569'
        }
      }
    }
  },
  plugins: []
};
