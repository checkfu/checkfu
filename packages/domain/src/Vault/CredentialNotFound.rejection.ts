import * as Domain from "@alchemy.run/domain"
import { CredentialId } from "./Credential.id.ts"

export class CredentialNotFound extends Domain.Rejection(
	"CredentialNotFound",
	{ credential_id: CredentialId },
	{ httpApiStatus: 404, description: "Credential does not exist in this vault." },
) {}
