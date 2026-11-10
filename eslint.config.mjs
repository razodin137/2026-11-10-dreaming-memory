import houseStyle from "/home/mrjohn/Work/tries/2026-11-03-house-style/house-style/eslint-config/eslint.config.mjs"
import globals from "globals"

export default [
  houseStyle,
  {
    languageOptions: {
      globals: {
        ...globals.node
      }
    }
  },
  {
    ignores: [ "memory.db", "memory.db-*", ".scratch/*" ]
  }
]
