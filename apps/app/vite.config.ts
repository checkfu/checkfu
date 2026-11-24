import { THEME_SCRIPT } from "@checkfu/ui/theme-script"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
	plugins: [
		react(),
		tailwindcss(),
		{
			name: "checkfu-theme",
			transformIndexHtml: () => [
				{ tag: "script", children: THEME_SCRIPT, injectTo: "head-prepend" },
			],
		},
	],
})
