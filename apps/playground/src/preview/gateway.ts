/**
 * Page side of the preview gateway.
 *
 * public/owc-sw.js answers /__owc/preview/<port>/<path> by posting an
 * 'owc-preview-request' message to this page. startPreviewGateway hands the request
 * to the app's handler (which forwards it through the container's worker bridge) and
 * returns the response over the MessagePort that the service worker supplied.
 *
 * HTTP ingress only. A browser cannot provide raw TCP or UDP sockets, so the
 * container's virtual TCP/UDP stays inside the container. Bodies are carried as UTF-8
 * text, which matches the container's HTTP bridge; binary bodies are not preserved.
 */

const PREVIEW_PREFIX = '/__owc/preview';
const SERVICE_WORKER_URL = '/owc-sw.js';
const REQUEST_MESSAGE = 'owc-preview-request';
const PORTS_MESSAGE = 'owc-preview-ports';
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Ports this page's container is serving. The service worker routes a preview by port,
 * so a page that never says what it is serving may never be asked, and a stale entry
 * would keep sending requests to a server that has gone away.
 */
let advertisedPorts: number[] = [];

function advertisePorts(): void {
	const controller = navigator.serviceWorker && navigator.serviceWorker.controller;
	if (!controller) return;
	try {
		controller.postMessage({ type: PORTS_MESSAGE, ports: advertisedPorts });
	} catch {
		/* the worker is not ready; the next advertisement will reach it */
	}
}

let previewPortsSink: ((ports: number[]) => void) | null = null;

/** Tell the gateway which ports this page's container serves, so previews are routed here. */
export function setPreviewPorts(ports: number[]): void {
	if (previewPortsSink) previewPortsSink(ports);
}

export interface PreviewRequest {
	method: string;
	/** Path plus query as the guest server sees it, for example "/hello?x=1". */
	path: string;
	headers: Record<string, string>;
	/** Request body as UTF-8 text, or undefined when the request has none. */
	body: string | undefined;
}

export type PreviewHandler = (port: number, request: PreviewRequest) => Promise<Response>;

interface PreviewMessage {
	type: typeof REQUEST_MESSAGE;
	id: string;
	port: number;
	method: string;
	path: string;
	headers: Record<string, string>;
	body: string | null;
}

// Module-level so repeated starts (for example React StrictMode effects) share one listener.
let activeHandler: PreviewHandler | null = null;
let listening = false;
let controllerBound = false;

/** Browser URL for a server inside the container, for example previewUrl(3070, "/hello"). */
export function previewUrl(port: number, path: string = "/"): string {
	const suffix = path === "" || path.startsWith("/") ? path : `/${path}`;
	return `${PREVIEW_PREFIX}/${port}${suffix}`;
}

/**
 * Registers the preview service worker and routes its requests to `handle`.
 * Resolves to a stop function, or null when this browser cannot run the gateway.
 */
export async function startPreviewGateway(handle: PreviewHandler): Promise<(() => void) | null> {
	activeHandler = handle;
	const stop = () => {
		if (activeHandler === handle) {
			activeHandler = null;
		}
		setPreviewPorts([]);
	};

	/** Tell the gateway which ports this page's container serves, so previews are routed here. */
	function setPreviewPorts(ports: number[]): void {
		const next = Array.from(new Set(ports.filter((port) => Number.isInteger(port)))).sort((a, b) => a - b);
		if (next.length === advertisedPorts.length && next.every((port, index) => port === advertisedPorts[index])) {
			return;
		}
		advertisedPorts = next;
		advertisePorts();
	}
	previewPortsSink = setPreviewPorts;

	if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
		console.warn("[preview] Service workers are not supported here; the preview gateway is disabled.");
		return null;
	}
	if (!window.isSecureContext && !LOCAL_HOSTS.includes(location.hostname)) {
		console.warn("[preview] The preview gateway needs https or localhost; it is disabled on this origin.");
		return null;
	}

	if (!listening) {
		navigator.serviceWorker.addEventListener("message", onWorkerMessage);
		listening = true;
	}

	try {
		await navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: "/" });
	} catch (error) {
		console.warn("[preview] Service worker registration failed.", error);
		stop();
		return null;
	}
	// Say what this page serves, and say it again if the worker is replaced.
	advertisePorts();
	if (!controllerBound) {
		navigator.serviceWorker.addEventListener("controllerchange", advertisePorts);
		controllerBound = true;
	}
	return stop;
}

async function onWorkerMessage(event: MessageEvent): Promise<void> {
	const message = event.data as PreviewMessage | undefined;
	if (!message || message.type !== REQUEST_MESSAGE) {
		return;
	}
	const reply = event.ports[0];
	if (!reply) {
		return;
	}

	const handler = activeHandler;
	if (!handler) {
		reply.postMessage({ error: "The preview gateway is not running in this page." });
		return;
	}

	try {
		const response = await handler(message.port, {
			method: message.method,
			path: message.path,
			headers: message.headers,
			body: message.body === null ? undefined : decodeBase64ToText(message.body),
		});
		const headers: Record<string, string> = {};
		response.headers.forEach((value, name) => {
			headers[name] = value;
		});
		const bytes = new Uint8Array(await response.arrayBuffer());
		reply.postMessage({
			status: response.status,
			statusText: response.statusText,
			headers,
			body: encodeBytesToBase64(bytes),
		});
	} catch (error) {
		reply.postMessage({ error: error instanceof Error ? error.message : String(error) });
	}
}

function decodeBase64ToText(text: string): string {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return new TextDecoder().decode(bytes);
}

function encodeBytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}
