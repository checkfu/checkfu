import { THEME_SCRIPT } from "@checkfu/ui/theme-script"
import babel from "@rolldown/plugin-babel"
import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import react, { reactCompilerPreset } from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
	plugins: [
		tanstackRouter({ target: "react", autoCodeSplitting: true }),
		react(),
		babel({ presets: [reactCompilerPreset()] }),
		tailwindcss(),
		{
			name: "checkfu-theme",
			transformIndexHtml: () => [
				{ tag: "script", children: THEME_SCRIPT, injectTo: "head-prepend" },
			],
		},
	],
})
