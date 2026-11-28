// Secret request fields (a vault credential's `auth.token`) are `Redacted` values, so they never show up
// in logs, errors or `toString()`. Build them with `secret()`: it uses the SDK's own copy of
// `effect`, which matters because a `Redacted` made by a different copy of `effect` is not recognized.
import * as Redacted from "effect/Redacted"

/** Wrap a secret for a `Redacted` request field such as a vault credential's `auth.token`. */
export const secret = (value: string): Redacted.Redacted<string> => Redacted.make(value)

export type Secret = Redacted.Redacted<string>
