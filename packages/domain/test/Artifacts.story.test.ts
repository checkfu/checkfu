import * as Domain from "@alchemy.run/domain"
import { Story } from "@alchemy.run/domain/Story"
import { describe, expect, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
	AddArtifactVersion,
	ArtifactVersionAdded,
	ArtifactVersionConflict,
} from "../src/Artifact/AddArtifactVersion.command.ts"
import { Artifact } from "../src/Artifact/Artifact.aggregate.ts"
import { ArtifactBytes, ArtifactBytesKept } from "../src/Artifact/ArtifactBytes.external.ts"
import { decodeCapabilities, encodeCapabilities } from "../src/Artifact/ArtifactCapabilities.ts"
import type { ArtifactCapabilities } from "../src/Artifact/ArtifactCapabilities.ts"
import { ArtifactNotFound } from "../src/Artifact/ArtifactNotFound.rejection.ts"
import {
	ArtifactVersionView,
	artifactVersionLookupKey,
} from "../src/Artifact/ArtifactVersionView.view.ts"
import {
	ArtifactIdempotencyKeyClaimed,
	ClaimArtifactIdempotencyKey,
} from "../src/Artifact/ClaimArtifactIdempotencyKey.command.ts"
import {
	ArtifactAlreadyExists,
	ArtifactCreated,
	CreateArtifact,
} from "../src/Artifact/CreateArtifact.command.ts"
import { ArtifactReservationLapsed } from "../src/Artifact/ArtifactReservationLapsed.rejection.ts"
import { ArtifactDeleted, DeleteArtifact } from "../src/Artifact/DeleteArtifact.command.ts"
import {
	ARTIFACT_RESERVATION_TTL,
	ArtifactReservationExpired,
	ExpireArtifactReservation,
} from "../src/Artifact/ExpireArtifactReservation.command.ts"
import {
	ArtifactPublished,
	ArtifactVersionNotFound,
	PublishArtifact,
} from "../src/Artifact/PublishArtifact.command.ts"
import { ArtifactReserved, ReserveArtifact } from "../src/Artifact/ReserveArtifact.command.ts"
import {
	ArtifactUnpublished,
	UnpublishArtifact,
} from "../src/Artifact/UnpublishArtifact.command.ts"
import { Artifacts, ArtifactsHandlersLive } from "../src/Artifacts.model.ts"

const story = Story.make(Artifacts, { layer: ArtifactsHandlersLive, stub: [ArtifactBytes] })

const t0 = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")
const t1 = DateTime.makeUnsafe("2026-01-01T00:05:00.000Z")
const t2 = DateTime.makeUnsafe("2026-01-01T00:10:00.000Z")

const manifestA = "a".repeat(64)
const manifestB = "b".repeat(64)
const manifestC = "c".repeat(64)

describe("Artifacts", () => {
	it.effect("is well defined", () =>
		Effect.scoped(Layer.build(Artifacts.layer(ArtifactsHandlersLive))).pipe(
			Effect.provide([Domain.InMemory, ArtifactBytesKept]),
		),
	)

	it.effect("creates an artifact, adds a version and projects the head and each version", () => {
		const artifact = Artifact.ref("art_001")
		return story(
			Story.clock(t0),
			Story.state(artifact, {
				status: "",
				version: 0,
				name: "",
				manifest: "",
				open_reservation: 0,
			}),
			Story.when(new ReserveArtifact({ artifact_id: artifact.id })),
			Story.then(artifact, new ArtifactReserved({ reservation: 1 })),
			Story.replied({ reservation: 1 }),
			Story.state(artifact, { status: "", reservations: 1, open_reservation: 1 }),
			Story.when(
				new CreateArtifact({
					artifact_id: artifact.id,
					name: "Report",
					manifest: manifestA,
					file_count: 2,
					total_bytes: 1024,
					capabilities: "",
					reservation: 1,
				}),
			),
			Story.then(
				artifact,
				new ArtifactCreated({
					version: 1,
					name: "Report",
					manifest: manifestA,
					file_count: 2,
					total_bytes: 1024,
					capabilities: "",
				}),
			),
			Story.replied({ version: 1 }),
			Story.state(artifact, {
				status: "active",
				version: 1,
				name: "Report",
				manifest: manifestA,
				open_reservation: 0,
				created_at: DateTime.toEpochMillis(t0),
				updated_at: DateTime.toEpochMillis(t0),
			}),
			Story.view(ArtifactVersionView, artifactVersionLookupKey(artifact.id, 1), {
				artifact_id: artifact.id,
				type: "artifact_version",
				version: 1,
				manifest: manifestA,
				file_count: 2,
				total_bytes: 1024,
				capabilities: "",
				created_at: t0,
			}),
			Story.view(ArtifactVersionView, artifactVersionLookupKey(artifact.id, 2), Story.none),
			Story.clock(t1),
			Story.when(
				new AddArtifactVersion({
					artifact_id: artifact.id,
					expected_version: 1,
					manifest: manifestB,
					file_count: 3,
					total_bytes: 0,
					capabilities: "",
				}),
			),
			Story.then(
				artifact,
				new ArtifactVersionAdded({
					version: 2,
					manifest: manifestB,
					file_count: 3,
					total_bytes: 0,
					capabilities: "",
				}),
			),
			Story.replied({ version: 2 }),
			Story.state(artifact, {
				status: "active",
				version: 2,
				name: "Report",
				manifest: manifestB,
				created_at: DateTime.toEpochMillis(t0),
				updated_at: DateTime.toEpochMillis(t1),
			}),
			Story.view(ArtifactVersionView, artifactVersionLookupKey(artifact.id, 1), {
				artifact_id: artifact.id,
				type: "artifact_version",
				version: 1,
				manifest: manifestA,
				file_count: 2,
				total_bytes: 1024,
				capabilities: "",
				created_at: t0,
			}),
			Story.view(ArtifactVersionView, artifactVersionLookupKey(artifact.id, 2), {
				artifact_id: artifact.id,
				type: "artifact_version",
				version: 2,
				manifest: manifestB,
				file_count: 3,
				total_bytes: 0,
				capabilities: "",
				created_at: t1,
			}),
		)
	})

	it.effect("keeps two artifacts' versions apart", () => {
		const first = Artifact.ref("art_first")
		const second = Artifact.ref("art_second")
		return story(
			Story.clock(t0),
			Story.given(
				first,
				new ArtifactCreated({
					version: 1,
					name: "First",
					manifest: manifestA,
					file_count: 1,
					total_bytes: 10,
					capabilities: "",
				}),
			),
			Story.given(
				second,
				new ArtifactCreated({
					version: 1,
					name: "Second",
					manifest: manifestB,
					file_count: 1,
					total_bytes: 20,
					capabilities: "",
				}),
			),
			Story.view(ArtifactVersionView, artifactVersionLookupKey(first.id, 1), {
				artifact_id: first.id,
				manifest: manifestA,
			}),
			Story.view(ArtifactVersionView, artifactVersionLookupKey(second.id, 1), {
				artifact_id: second.id,
				manifest: manifestB,
			}),
		)
	})

	it.effect(
		"refuses a duplicate create, a stale version and anything on a missing artifact",
		() => {
			const missing = Artifact.ref("art_missing")
			const artifact = Artifact.ref("art_002")
			return story(
				Story.clock(t0),
				Story.when(
					new AddArtifactVersion({
						artifact_id: missing.id,
						expected_version: 1,
						manifest: manifestA,
						file_count: 1,
						total_bytes: 1,
						capabilities: "",
					}),
				),
				Story.rejected(new ArtifactNotFound({ artifact_id: missing.id })),
				Story.when(new DeleteArtifact({ artifact_id: missing.id })),
				Story.rejected(new ArtifactNotFound({ artifact_id: missing.id })),
				Story.state(missing, { status: "", version: 0, name: "", manifest: "" }),
				Story.given(
					artifact,
					new ArtifactCreated({
						version: 1,
						name: "Site",
						manifest: manifestA,
						file_count: 1,
						total_bytes: 12,
						capabilities: "",
					}),
				),
				Story.when(
					new CreateArtifact({
						artifact_id: artifact.id,
						name: "Duplicate",
						manifest: manifestB,
						file_count: 1,
						total_bytes: 1,
						capabilities: "",
						reservation: 1,
					}),
				),
				Story.rejected(new ArtifactAlreadyExists({ artifact_id: artifact.id })),
				Story.when(
					new AddArtifactVersion({
						artifact_id: artifact.id,
						expected_version: 2,
						manifest: manifestB,
						file_count: 1,
						total_bytes: 1,
						capabilities: "",
					}),
				),
				Story.rejected(
					new ArtifactVersionConflict({
						artifact_id: artifact.id,
						expected_version: 2,
						current_version: 1,
					}),
				),
				Story.state(artifact, {
					status: "active",
					version: 1,
					name: "Site",
					manifest: manifestA,
				}),
				Story.view(ArtifactVersionView, artifactVersionLookupKey(artifact.id, 2), Story.none),
			)
		},
	)

	it.effect("deletes an artifact for good, keeping the versions it had", () => {
		const artifact = Artifact.ref("art_003")
		return story(
			Story.clock(t0),
			Story.given(
				artifact,
				new ArtifactCreated({
					version: 1,
					name: "Draft",
					manifest: manifestA,
					file_count: 1,
					total_bytes: 5,
					capabilities: "",
				}),
			),
			Story.clock(t1),
			Story.when(
				new AddArtifactVersion({
					artifact_id: artifact.id,
					expected_version: 1,
					manifest: manifestB,
					file_count: 1,
					total_bytes: 6,
					capabilities: "",
				}),
			),
			Story.then(
				artifact,
				new ArtifactVersionAdded({
					version: 2,
					manifest: manifestB,
					file_count: 1,
					total_bytes: 6,
					capabilities: "",
				}),
			),
			Story.replied({ version: 2 }),
			Story.clock(t2),
			Story.when(new DeleteArtifact({ artifact_id: artifact.id })),
			Story.then(artifact, new ArtifactDeleted()),
			Story.call(ArtifactBytes.purge, { artifact_id: artifact.id }),
			Story.succeed(ArtifactBytes.purge, undefined),
			Story.state(artifact, {
				status: "deleted",
				version: 2,
				name: "Draft",
				manifest: manifestB,
			}),
			Story.view(ArtifactVersionView, artifactVersionLookupKey(artifact.id, 1), {
				artifact_id: artifact.id,
				version: 1,
				manifest: manifestA,
				created_at: t0,
			}),
			Story.view(ArtifactVersionView, artifactVersionLookupKey(artifact.id, 2), {
				artifact_id: artifact.id,
				version: 2,
				manifest: manifestB,
				created_at: t1,
			}),
			Story.when(new DeleteArtifact({ artifact_id: artifact.id })),
			Story.rejected(new ArtifactNotFound({ artifact_id: artifact.id })),
			Story.when(
				new AddArtifactVersion({
					artifact_id: artifact.id,
					expected_version: 2,
					manifest: manifestC,
					file_count: 1,
					total_bytes: 7,
					capabilities: "",
				}),
			),
			Story.rejected(new ArtifactNotFound({ artifact_id: artifact.id })),
			Story.when(
				new CreateArtifact({
					artifact_id: artifact.id,
					name: "Resurrected",
					manifest: manifestC,
					file_count: 1,
					total_bytes: 7,
					capabilities: "",
					reservation: 1,
				}),
			),
			Story.rejected(new ArtifactAlreadyExists({ artifact_id: artifact.id })),
			Story.state(artifact, {
				status: "deleted",
				version: 2,
				name: "Draft",
				manifest: manifestB,
			}),
		)
	})

	it.effect(
		"creates only under the latest reservation, and lets no create land once that expires",
		() => {
			const artifact = Artifact.ref("art_reserved")
			const create = (reservation: number) =>
				new CreateArtifact({
					artifact_id: artifact.id,
					name: "Reserved",
					manifest: manifestA,
					file_count: 1,
					total_bytes: 1,
					capabilities: "",
					reservation,
				})
			const reserve = new ReserveArtifact({ artifact_id: artifact.id })
			const expire = (reservation: number) =>
				new ExpireArtifactReservation({ artifact_id: artifact.id, reservation })
			const lapsed = new ArtifactReservationLapsed({ artifact_id: artifact.id })
			return story(
				Story.clock(t0),
				Story.when(create(0)),
				Story.rejected(lapsed),
				Story.when(reserve),
				Story.then(artifact, new ArtifactReserved({ reservation: 1 })),
				Story.when(reserve),
				Story.then(artifact, new ArtifactReserved({ reservation: 2 })),
				Story.replied({ reservation: 2 }),
				Story.when(create(1)),
				Story.rejected(lapsed),
				Story.when(expire(1)),
				Story.then(artifact),
				Story.state(artifact, { status: "", reservations: 2, open_reservation: 2 }),
				Story.advance(ARTIFACT_RESERVATION_TTL),
				Story.then(artifact, new ArtifactReservationExpired({ reservation: 2 })),
				Story.call(ArtifactBytes.release, { artifact_id: artifact.id, reservation: 2 }),
				Story.succeed(ArtifactBytes.release, undefined),
				Story.state(artifact, { status: "", reservations: 2, open_reservation: 0 }),
				Story.when(create(2)),
				Story.rejected(lapsed),
				Story.when(reserve),
				Story.then(artifact, new ArtifactReserved({ reservation: 3 })),
				Story.when(create(3)),
				Story.then(
					artifact,
					new ArtifactCreated({
						version: 1,
						name: "Reserved",
						manifest: manifestA,
						file_count: 1,
						total_bytes: 1,
						capabilities: "",
					}),
				),
				Story.state(artifact, { status: "active", reservations: 3, open_reservation: 0 }),
				Story.when(expire(3)),
				Story.then(artifact),
				Story.when(reserve),
				Story.rejected(new ArtifactAlreadyExists({ artifact_id: artifact.id })),
				Story.state(artifact, { status: "active", reservations: 3, open_reservation: 0 }),
			)
		},
	)

	it.effect(
		"opens a publication for viewing only, and changes what the public may do only when told",
		() => {
			const artifact = Artifact.ref("art_granted")
			const responses = '{"responses":"add"}'
			const publish = (access: "" | "view" | "read" | "write", grant: string, pinned_version = 0) =>
				new PublishArtifact({
					artifact_id: artifact.id,
					token: "tok",
					pinned_version,
					access,
					grant,
				})
			const published = (access: "view" | "read" | "write", grant: string, pinned_version = 0) =>
				new ArtifactPublished({ token: "tok", pinned_version, access, grant })
			return story(
				Story.given(
					artifact,
					new ArtifactCreated({
						version: 1,
						name: "Form",
						manifest: manifestA,
						file_count: 1,
						total_bytes: 1,
						capabilities: "",
					}),
				),
				Story.given(
					artifact,
					new ArtifactVersionAdded({
						version: 2,
						manifest: manifestB,
						file_count: 1,
						total_bytes: 2,
						capabilities: "",
					}),
				),
				Story.clock(t0),
				Story.when(publish("", "")),
				Story.then(artifact, published("view", "")),
				Story.state(artifact, { public_access: "view", public_grant: "" }),
				Story.when(publish("write", responses)),
				Story.then(artifact, published("write", responses)),
				Story.state(artifact, { public_access: "write", public_grant: responses }),
				Story.when(publish("write", responses)),
				Story.then(artifact),
				Story.when(publish("", "", 1)),
				Story.then(artifact, published("write", responses, 1)),
				Story.state(artifact, {
					pinned_version: 1,
					public_access: "write",
					public_grant: responses,
				}),
				Story.when(publish("", '{"ignored":"write"}', 1)),
				Story.then(artifact),
				Story.when(publish("read", "", 1)),
				Story.then(artifact, published("read", "", 1)),
				Story.when(publish("view", '{"dropped":"read"}', 1)),
				Story.then(artifact, published("view", "", 1)),
				Story.state(artifact, { public_access: "view", public_grant: "" }),
				Story.when(new UnpublishArtifact({ artifact_id: artifact.id })),
				Story.then(artifact, new ArtifactUnpublished()),
				Story.state(artifact, { publication_token: "", public_access: "", public_grant: "" }),
				Story.when(publish("read", '{"settings":"read"}')),
				Story.then(artifact, published("read", '{"settings":"read"}')),
				Story.when(new DeleteArtifact({ artifact_id: artifact.id })),
				Story.then(artifact, new ArtifactDeleted()),
				Story.call(ArtifactBytes.purge, { artifact_id: artifact.id }),
				Story.succeed(ArtifactBytes.purge, undefined),
				Story.state(artifact, { status: "deleted", public_access: "", public_grant: "" }),
			)
		},
	)

	it.effect("publishes with a fresh token, keeps it on republish and never takes another", () => {
		const artifact = Artifact.ref("art_pub")
		const publish = (token: string, pinned_version: number) =>
			new PublishArtifact({
				artifact_id: artifact.id,
				token,
				pinned_version,
				access: "",
				grant: "",
			})
		const millis = DateTime.toEpochMillis
		return story(
			Story.given(
				artifact,
				new ArtifactCreated({
					version: 1,
					name: "Page",
					manifest: manifestA,
					file_count: 1,
					total_bytes: 1,
					capabilities: "",
				}),
			),
			Story.given(
				artifact,
				new ArtifactVersionAdded({
					version: 2,
					manifest: manifestB,
					file_count: 1,
					total_bytes: 2,
					capabilities: "",
				}),
			),
			Story.clock(t0),
			Story.when(publish("first", 0)),
			Story.then(
				artifact,
				new ArtifactPublished({ token: "first", pinned_version: 0, access: "view", grant: "" }),
			),
			Story.state(artifact, {
				publication_token: "first",
				pinned_version: 0,
				published_at: millis(t0),
			}),
			Story.when(publish("unused", 0)),
			Story.then(artifact),
			Story.clock(t1),
			Story.when(publish("unused", 2)),
			Story.then(
				artifact,
				new ArtifactPublished({ token: "first", pinned_version: 2, access: "view", grant: "" }),
			),
			Story.state(artifact, {
				publication_token: "first",
				pinned_version: 2,
				published_at: millis(t1),
			}),
			Story.when(publish("unused", 3)),
			Story.rejected(new ArtifactVersionNotFound({ artifact_id: artifact.id, version: 3 })),
			Story.when(new UnpublishArtifact({ artifact_id: artifact.id })),
			Story.then(artifact, new ArtifactUnpublished()),
			Story.state(artifact, { publication_token: "", pinned_version: 0, published_at: 0 }),
			Story.when(new UnpublishArtifact({ artifact_id: artifact.id })),
			Story.then(artifact),
			Story.clock(t2),
			Story.when(publish("second", 1)),
			Story.then(
				artifact,
				new ArtifactPublished({ token: "second", pinned_version: 1, access: "view", grant: "" }),
			),
			Story.state(artifact, {
				publication_token: "second",
				pinned_version: 1,
				published_at: millis(t2),
			}),
			Story.when(new DeleteArtifact({ artifact_id: artifact.id })),
			Story.then(artifact, new ArtifactDeleted()),
			Story.call(ArtifactBytes.purge, { artifact_id: artifact.id }),
			Story.succeed(ArtifactBytes.purge, undefined),
			Story.state(artifact, {
				status: "deleted",
				publication_token: "",
				pinned_version: 0,
				published_at: 0,
			}),
			Story.when(publish("third", 0)),
			Story.rejected(new ArtifactNotFound({ artifact_id: artifact.id })),
			Story.when(new UnpublishArtifact({ artifact_id: artifact.id })),
			Story.rejected(new ArtifactNotFound({ artifact_id: artifact.id })),
		)
	})

	it.effect(
		"records the first fingerprint claimed under a command id, replays it for every later claim, and changes nothing",
		() => {
			const missing = Artifact.ref("art_missing")
			const artifact = Artifact.ref("art_claims")
			const claim = (fingerprint: string) =>
				new ClaimArtifactIdempotencyKey({ artifact_id: artifact.id, fingerprint })
			return story(
				Story.when(
					new ClaimArtifactIdempotencyKey({ artifact_id: missing.id, fingerprint: "fp_a" }),
				),
				Story.rejected(new ArtifactNotFound({ artifact_id: missing.id })),
				Story.given(
					artifact,
					new ArtifactCreated({
						version: 1,
						name: "Page",
						manifest: manifestA,
						file_count: 1,
						total_bytes: 1,
						capabilities: "",
					}),
				),
				Story.when(claim("fp_a"), { commandId: "publication:key-1" }),
				Story.then(artifact, new ArtifactIdempotencyKeyClaimed({ fingerprint: "fp_a" })),
				Story.state(artifact, { status: "active", version: 1, publication_token: "" }),
				Story.when(claim("fp_b"), { commandId: "publication:key-1" }),
				Story.then(artifact),
				Story.when(claim("fp_a"), { commandId: "publication:key-1" }),
				Story.then(artifact),
				Story.when(claim("fp_b"), { commandId: "publication:key-2" }),
				Story.then(artifact, new ArtifactIdempotencyKeyClaimed({ fingerprint: "fp_b" })),
				Story.when(new DeleteArtifact({ artifact_id: artifact.id })),
				Story.then(artifact, new ArtifactDeleted()),
				Story.call(ArtifactBytes.purge, { artifact_id: artifact.id }),
				Story.succeed(ArtifactBytes.purge, undefined),
				Story.when(claim("fp_c"), { commandId: "publication:key-3" }),
				Story.rejected(new ArtifactNotFound({ artifact_id: artifact.id })),
			)
		},
	)

	it("publishes on the artifact alone: no other aggregate and no decision take part", () => {
		expect(Artifacts.aggregates.map((aggregate) => aggregate.aggregateName)).toEqual(["Artifact"])
		expect(Artifacts.decisions).toEqual([])
		expect(Artifact.definition.commands).toContain(PublishArtifact)
		expect(Artifact.definition.commands).toContain(UnpublishArtifact)
	})

	it("records capabilities in one order whatever order they were declared in, and nothing for an empty declaration", () => {
		const forward: ArtifactCapabilities = {
			database: { collections: { a: { visitors: "read" }, b: { visitors: "add" } } },
		}
		const backward: ArtifactCapabilities = {
			database: { collections: { b: { visitors: "add" }, a: { visitors: "read" } } },
		}
		const text = encodeCapabilities(forward)
		expect(text).toBe(
			'{"database":{"collections":{"a":{"visitors":"read"},"b":{"visitors":"add"}}}}',
		)
		expect(encodeCapabilities(backward)).toBe(text)
		expect(decodeCapabilities(text ?? "")).toEqual(forward)
		expect(encodeCapabilities({})).toBe("")
		expect(encodeCapabilities({ database: { collections: {} } })).toBe("")
		expect(decodeCapabilities("")).toEqual({})
		expect(decodeCapabilities("not json")).toEqual({})
	})

	it.effect("keeps each version's capabilities, and changes them only with a new version", () => {
		const artifact = Artifact.ref("art_capable")
		const declared = '{"database":{"collections":{"votes":{"visitors":"add"}}}}'
		return story(
			Story.clock(t0),
			Story.when(new ReserveArtifact({ artifact_id: artifact.id })),
			Story.then(artifact, new ArtifactReserved({ reservation: 1 })),
			Story.when(
				new CreateArtifact({
					artifact_id: artifact.id,
					name: "Poll",
					manifest: manifestA,
					file_count: 2,
					total_bytes: 20,
					capabilities: declared,
					reservation: 1,
				}),
			),
			Story.then(
				artifact,
				new ArtifactCreated({
					version: 1,
					name: "Poll",
					manifest: manifestA,
					file_count: 2,
					total_bytes: 20,
					capabilities: declared,
				}),
			),
			Story.state(artifact, { version: 1, capabilities: declared }),
			Story.view(ArtifactVersionView, artifactVersionLookupKey(artifact.id, 1), {
				version: 1,
				capabilities: declared,
			}),
			Story.when(
				new PublishArtifact({
					artifact_id: artifact.id,
					token: "tok",
					pinned_version: 0,
					access: "",
					grant: "",
				}),
			),
			Story.then(
				artifact,
				new ArtifactPublished({ token: "tok", pinned_version: 0, access: "view", grant: "" }),
			),
			Story.state(artifact, { capabilities: declared }),
			Story.when(
				new AddArtifactVersion({
					artifact_id: artifact.id,
					expected_version: 1,
					manifest: manifestB,
					file_count: 1,
					total_bytes: 10,
					capabilities: "",
				}),
			),
			Story.then(
				artifact,
				new ArtifactVersionAdded({
					version: 2,
					manifest: manifestB,
					file_count: 1,
					total_bytes: 10,
					capabilities: "",
				}),
			),
			Story.state(artifact, { version: 2, capabilities: "" }),
			Story.view(ArtifactVersionView, artifactVersionLookupKey(artifact.id, 1), {
				capabilities: declared,
			}),
			Story.view(ArtifactVersionView, artifactVersionLookupKey(artifact.id, 2), {
				capabilities: "",
			}),
		)
	})
})
