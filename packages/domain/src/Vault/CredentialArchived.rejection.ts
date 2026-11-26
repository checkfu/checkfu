import * as Domain from "@alchemy.run/domain"
import { CredentialId } from "./Credential.id.ts"

export class CredentialArchivedError extends Domain.Rejection(
	"CredentialArchivedError",
	{ credential_id: CredentialId },
	{ httpApiStatus: 409, description: "Credential is archived and cannot be modified." },
) {}
