import { clsx } from "clsx"
import type { ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

const merge = extendTailwindMerge({ extend: { theme: { text: ["meta", "control"] } } })

export const cn = (...inputs: ReadonlyArray<ClassValue>): string => merge(clsx(inputs))
