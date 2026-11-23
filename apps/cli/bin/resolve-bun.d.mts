export interface ResolveBunOptions {
	readonly platform?: NodeJS.Platform
	readonly env?: Readonly<Record<string, string | undefined>>
	readonly cwd?: string
	readonly homedir?: string
	readonly isExecutableFile?: (candidate: string) => boolean
	readonly realpath?: (target: string) => string
}

export declare function resolveBunExecutable(options?: ResolveBunOptions): string | null
