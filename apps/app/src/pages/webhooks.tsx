import { Button } from "@checkfu/ui/button"
import { Callout } from "@checkfu/ui/callout"
import { PageHeader } from "@checkfu/ui/page-header"
import { useMountEffect } from "@checkfu/ui/use-mount-effect"
import { useRef } from "react"
import type { ComponentProps } from "react"
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query"
import { getRouteApi, Link } from "@tanstack/react-router"
import { ApiError } from "../api.ts"
import type { JsonWebhook, JsonWebhookDelivery } from "../api.ts"
import {
	webhookDeliveriesQuery,
	webhookDeliveryQuery,
	webhookQuery,
	webhooksQuery,
} from "../queries.ts"

const endpointRoute = getRouteApi("/_app/webhooks/$webhookId/")
const deliveryRoute = getRouteApi("/_app/webhooks/$webhookId/deliveries/$deliveryId")

const hostOf = ({ url }: JsonWebhook): string => URL.parse(url)?.hostname ?? "Unknown destination"

const endpoints: Record<JsonWebhook["status"], string> = {
	active: "Active",
	paused: "Paused",
	disabled_redirect: "Disabled after a redirect",
	disabled_sustained_failure: "Disabled after repeated failures",
	deleted: "Deleted",
}

const outcomes: Record<NonNullable<JsonWebhookDelivery["last_outcome"]>, string> = {
	http_2xx: "Accepted by receiver",
	http_redirect: "Receiver redirected the request",
	http_4xx: "Receiver rejected the request",
	http_5xx: "Receiver error",
	timeout: "Request timed out",
	network_error: "Network error",
	invalid_destination: "Invalid destination",
}

const deliveryStatus = (delivery: JsonWebhookDelivery): string => {
	switch (delivery.status) {
		case "pending":
			if (delivery.attempt_count === 0) {
				return "Queued"
			}
			return delivery.next_attempt_at === null ? "Pending" : "Retry scheduled"
		case "succeeded":
			return "Delivered"
		case "failed":
			return "Failed"
		case "skipped":
			return "Skipped"
	}
}

const shownHttpStatus = ({ last_outcome, last_http_status }: JsonWebhookDelivery): string =>
	last_http_status !== null && last_outcome?.startsWith("http_") === true
		? `HTTP ${last_http_status}`
		: "—"

const labels = (endpoint: JsonWebhook) =>
	[hostOf(endpoint), endpoint.description === "" ? undefined : endpoint.description]
		.filter((value) => value !== undefined)
		.join(" · ")

function Timestamp({ at }: { readonly at: string | null }) {
	return at === null ? "—" : <time dateTime={at}>{new Date(at).toLocaleString()}</time>
}

function ReadError({ message, retry }: { readonly message: string; readonly retry: () => void }) {
	return (
		<Callout tone="error">
			{message}{" "}
			<Button type="button" variant="outline" size="sm" onClick={retry}>
				Retry
			</Button>
		</Callout>
	)
}

const distinct = <A extends { readonly id: string }>(items: ReadonlyArray<A>): ReadonlyArray<A> => [
	...new Map(items.map((item) => [item.id, item] as const)).values(),
]

function WebhookHeading(props: ComponentProps<typeof PageHeader>) {
	const section = useRef<HTMLDivElement>(null)
	useMountEffect(() => {
		const title = section.current?.querySelector("h1")
		if (title !== undefined && title !== null) {
			title.tabIndex = -1
			title.focus()
		}
	})
	return (
		<div ref={section}>
			<PageHeader {...props} />
		</div>
	)
}

export function WebhooksPage() {
	const directory = useInfiniteQuery(webhooksQuery())
	const entries = distinct(directory.data?.pages.flatMap(({ data }) => data) ?? [])
	return (
		<>
			<WebhookHeading title="Webhooks" />
			{directory.isPending ? <p role="status">Loading webhook endpoints…</p> : null}
			{directory.isError ? (
				<ReadError
					message="Could not load webhook endpoints."
					retry={() =>
						void (directory.isFetchNextPageError ? directory.fetchNextPage() : directory.refetch())
					}
				/>
			) : null}
			{entries.length === 0 && directory.isSuccess && !directory.hasNextPage ? (
				<p>No webhook endpoints.</p>
			) : null}
			{entries.length === 0 ? null : (
				<table className="w-full text-left text-sm">
					<thead>
						<tr className="border-b">
							<th scope="col">Endpoint</th>
							<th scope="col">Status</th>
						</tr>
					</thead>
					<tbody>
						{entries.map((endpoint) => (
							<tr key={endpoint.id} className="border-b">
								<td className="py-2">
									<Link
										to="/webhooks/$webhookId"
										params={{ webhookId: endpoint.id }}
										className="underline"
										preload={false}
									>
										{labels(endpoint)}
									</Link>
								</td>
								<td>{endpoints[endpoint.status]}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			{directory.hasNextPage ? (
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="mt-4"
					disabled={directory.isFetchingNextPage}
					onClick={() => void directory.fetchNextPage()}
				>
					Load more endpoints
				</Button>
			) : null}
		</>
	)
}

const isUnavailable = (error: unknown): boolean => error instanceof ApiError && error.status === 404

export function WebhookPage() {
	const { webhookId } = endpointRoute.useParams()
	const endpoint = useQuery(webhookQuery(webhookId))
	return (
		<>
			<WebhookHeading
				title={
					endpoint.data === undefined || isUnavailable(endpoint.error)
						? "Webhook endpoint"
						: hostOf(endpoint.data)
				}
				id={webhookId}
				breadcrumb={<Link to="/webhooks">Webhooks</Link>}
			/>
			{endpoint.isPending ? <p role="status">Loading webhook endpoint…</p> : null}
			{endpoint.isError ? (
				isUnavailable(endpoint.error) ? (
					<Callout tone="error">Webhook endpoint unavailable.</Callout>
				) : (
					<ReadError
						message="Could not load the webhook endpoint."
						retry={() => void endpoint.refetch()}
					/>
				)
			) : null}
			{endpoint.data === undefined || isUnavailable(endpoint.error) ? null : (
				<>
					<p>Status {endpoints[endpoint.data.status]}</p>
					{endpoint.data.description === "" ? null : <p>{endpoint.data.description}</p>}
					<DeliveryHistory key={webhookId} webhookId={webhookId} />
				</>
			)}
		</>
	)
}

function DeliveryHistory({ webhookId }: { readonly webhookId: string }) {
	const client = useQueryClient()
	const definition = webhookDeliveriesQuery(webhookId)
	const history = useInfiniteQuery(definition)
	const entries = distinct(history.data?.pages.flatMap(({ data }) => data) ?? [])
	const refresh = async () => {
		await client
			.fetchInfiniteQuery({ ...definition, staleTime: 0, pages: 1 })
			.catch(() => undefined)
	}
	return (
		<section aria-label="Deliveries" className="mt-6 space-y-3">
			<div className="flex items-center justify-between gap-2">
				<h2 className="font-medium">Deliveries</h2>
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={history.isFetching}
					onClick={() => void refresh()}
				>
					Refresh deliveries
				</Button>
			</div>
			{history.isPending ? <p role="status">Loading deliveries…</p> : null}
			{history.isError ? (
				<ReadError
					message="Could not load deliveries."
					retry={() =>
						void (history.isFetchNextPageError ? history.fetchNextPage() : history.refetch())
					}
				/>
			) : null}
			{entries.length === 0 && history.isSuccess && !history.hasNextPage ? (
				<p>No recent deliveries.</p>
			) : null}
			{entries.length === 0 ? null : (
				<div className="overflow-x-auto">
					<table className="w-full text-left text-sm">
						<thead>
							<tr className="border-b">
								<th scope="col">Delivery</th>
								<th scope="col">Status</th>
								<th scope="col">Attempts</th>
								<th scope="col">Created</th>
							</tr>
						</thead>
						<tbody>
							{entries.map((delivery) => (
								<tr key={delivery.id} className="border-b">
									<td className="py-2">
										<Link
											to="/webhooks/$webhookId/deliveries/$deliveryId"
											params={{ webhookId, deliveryId: delivery.id }}
											className="underline"
											preload={false}
										>
											{delivery.event_type} <span className="block text-xs">{delivery.id}</span>
										</Link>
									</td>
									<td>{deliveryStatus(delivery)}</td>
									<td>
										{delivery.attempt_count} / {delivery.max_attempts}
									</td>
									<td>
										<Timestamp at={delivery.created_at} />
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
			{history.hasNextPage ? (
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={history.isFetchingNextPage}
					onClick={() => void history.fetchNextPage()}
				>
					Load earlier deliveries
				</Button>
			) : null}
		</section>
	)
}

export function WebhookDeliveryPage() {
	const { webhookId, deliveryId } = deliveryRoute.useParams()
	const endpoint = useQuery(webhookQuery(webhookId))
	const result = useQuery(webhookDeliveryQuery(webhookId, deliveryId))
	const delivery = result.data
	const unavailable = isUnavailable(endpoint.error) || isUnavailable(result.error)
	const breadcrumb = (
		<Link to="/webhooks/$webhookId" params={{ webhookId }}>
			Delivery history
		</Link>
	)
	return (
		<>
			<WebhookHeading title="Webhook delivery" id={deliveryId} breadcrumb={breadcrumb} />
			{endpoint.data === undefined || unavailable ? null : (
				<p>
					{hostOf(endpoint.data)} · {endpoints[endpoint.data.status]}
				</p>
			)}
			{unavailable ? <Callout tone="error">Delivery unavailable. {breadcrumb}</Callout> : null}
			{!unavailable && result.isPending ? <p role="status">Loading delivery…</p> : null}
			{!unavailable && result.isError ? (
				<ReadError message="Could not load this delivery." retry={() => void result.refetch()} />
			) : null}
			{delivery === undefined || unavailable ? null : (
				<dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
					<dt>Event</dt>
					<dd>
						{delivery.event_type} · {delivery.event_id}
					</dd>
					<dt>Status</dt>
					<dd role="status">{deliveryStatus(delivery)}</dd>
					<dt>Attempts</dt>
					<dd>
						{delivery.attempt_count} / {delivery.max_attempts}
					</dd>
					<dt>Last outcome</dt>
					<dd>{delivery.last_outcome === null ? "—" : outcomes[delivery.last_outcome]}</dd>
					<dt>Last HTTP status</dt>
					<dd>{shownHttpStatus(delivery)}</dd>
					<dt>Created</dt>
					<dd>
						<Timestamp at={delivery.created_at} />
					</dd>
					<dt>Last attempt</dt>
					<dd>
						<Timestamp at={delivery.last_attempt_at} />
					</dd>
					<dt>Next attempt</dt>
					<dd>
						<Timestamp at={delivery.next_attempt_at} />
					</dd>
					<dt>Completed</dt>
					<dd>
						<Timestamp at={delivery.completed_at} />
					</dd>
				</dl>
			)}
		</>
	)
}
