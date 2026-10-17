import { useState, useCallback, useEffect } from "react";
import Terminal from "./components/Terminal";
import { useContainer } from "./hooks/useContainer";
import Editor from "@monaco-editor/react";
import { Allotment } from "allotment";
import "allotment/dist/style.css";
import { FileExplorer } from "./components/FileExplorer";
import { useFileTree } from "./hooks/useFileTree";
import { FolderOpen, Terminal as TerminalIcon, Code, Loader2, Save } from "lucide-react";
import { useShell } from "./hooks/useShell";
import { previewUrl, setPreviewPorts, startPreviewGateway } from "./preview/gateway";

export default function App() {
	const { ready: containerReady, container, servers } = useContainer();
	const {
		ready: shellReady,
		output,
		sendCommand,
		shell,
	} = useShell(container, {
		osc: true,
	});

	const fileTree = useFileTree(containerReady, container);
	const [currentFile, setCurrentFile] = useState("");
	const [fileContent, setFileContent] = useState("");
	const [isDirty, setIsDirty] = useState(false);
	const [isSaving, setIsSaving] = useState(false);
	const [currentEditorContent, setCurrentEditorContent] = useState("");

	const handleEditorChange = (value: string | undefined) => {
		if (!currentFile || !value) return;
		setCurrentEditorContent(value);
		setIsDirty(value !== fileContent);
	};

	const handleSave = useCallback(async () => {
		if (!currentFile || !isDirty) return;

		setIsSaving(true);
		try {
			container?.writeFile(currentFile, currentEditorContent);
			setFileContent(currentEditorContent);
			setIsDirty(false);

			// Visual feedback for save success
			setTimeout(() => {
				setIsSaving(false);
			}, 500);
		} catch (error) {
			console.error("Failed to save:", error);
			setIsSaving(false);
		}
	}, [currentFile, currentEditorContent, isDirty]);

	// Add keyboard shortcut for save
	const handleKeyPress = useCallback(
		(event: KeyboardEvent) => {
			if ((event.ctrlKey || event.metaKey) && event.key === "s") {
				event.preventDefault();
				handleSave();
			}
		},
		[handleSave]
	);

	// Add keyboard event listener
	useEffect(() => {
		document.addEventListener("keydown", handleKeyPress);
		return () => {
			document.removeEventListener("keydown", handleKeyPress);
		};
	}, [handleKeyPress]);

	useEffect(() => {
		if (container) {
			container.writeFile(
				"/server.js",
				`
const http = require('http');

const server = http.createServer((req, res) => {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('Hello World!');
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(\`Server running at http://localhost:\${PORT}/\`);
});`
			);
		}
	}, [container]);
	useEffect(() => {
		if (servers) {
			console.log(servers);
			// Tell the service worker which ports this tab serves, so previews reach this tab
			// even when several tabs are open with servers on the same port number.
			setPreviewPorts(servers);
		}
	}, [servers]);

	useEffect(() => {
		if (!containerReady || !container) return;
		let stopGateway: (() => void) | null = null;
		let unmounted = false;
		startPreviewGateway(async (port, request) => {
			await container.waitForReady();
			return container.handleHttpRequest(
				{ method: request.method, url: request.path, headers: request.headers, body: request.body },
				port
			);
		}).then((stop) => {
			if (unmounted) stop?.();
			else stopGateway = stop;
		});
		return () => {
			unmounted = true;
			stopGateway?.();
		};
	}, [containerReady, container]);

	const handleSelectFile = async (path: string) => {
		// Prompt to save if there are unsaved changes
		if (isDirty) {
			const save = window.confirm("You have unsaved changes. Do you want to save them before switching files?");
			if (save) {
				handleSave();
			}
		}
		if (!container) {
			return;
		}

		setCurrentFile(path);
		const content = (await container.readFile(path)) || "";
		setFileContent(content);
		setCurrentEditorContent(content);
		setIsDirty(false);
	};

	const handleCreateFile = (path: string) => {
		container?.writeFile(path, "");
	};

	const handleCreateDirectory = (path: string) => {
		container?.createDirectory(path);
	};

	const handleDeletePath = (path: string) => {
		try {
			container?.deleteFile(path);
			if (path === currentFile) {
				setCurrentFile("");
				setFileContent("");
				setCurrentEditorContent("");
				setIsDirty(false);
			}
		} catch {
			// container?.deleteDirectory(path);
		}
	};

	if (!containerReady || !shellReady) {
		return (
			<div className="h-screen w-screen flex items-center justify-center bg-gray-900">
				<div className="text-center space-y-4">
					<Loader2 className="h-8 w-8 animate-spin text-blue-500 mx-auto" />
					<p className="text-gray-400">Initializing IDE...</p>
				</div>
			</div>
		);
	}

	return (
		<div className="h-screen w-screen flex flex-col bg-gray-900">
			{/* Header */}
			<div className="h-12 bg-gray-800 border-b border-gray-700 flex items-center px-4 justify-between">
				<div className="flex items-center space-x-2">
					<Code className="h-5 w-5 text-blue-400" />
					<h1 className="text-white font-semibold">Web IDE</h1>
					<span className="text-white font-semibold">running servers: {servers.length}</span>
						{servers.map((port) => (
							<a key={port} href={previewUrl(port, "/")} target="_blank" rel="noreferrer" className="text-sm text-blue-400 hover:text-blue-300 underline">
								Preview :{port}
							</a>
						))}
				</div>
				<div className="flex space-x-4">
					{/* Standard menu */}
					<div className="flex space-x-2">
						<button className="px-3 py-1 text-sm text-gray-300 hover:text-white transition-colors">File</button>
						<button className="px-3 py-1 text-sm text-gray-300 hover:text-white transition-colors">Edit</button>
						<button className="px-3 py-1 text-sm text-gray-300 hover:text-white transition-colors">View</button>
						<button className="px-3 py-1 text-sm text-gray-300 hover:text-white transition-colors">Help</button>
					</div>

					{/* Save button */}
					{currentFile && (
						<button
							onClick={handleSave}
							disabled={!isDirty || isSaving}
							className={`flex items-center space-x-1 px-3 py-1 rounded text-sm transition-all
                ${isDirty ? "bg-blue-500 hover:bg-blue-600 text-white" : "bg-gray-700 text-gray-400 cursor-not-allowed"}`}
						>
							<Save className={`h-4 w-4 ${isSaving ? "animate-spin" : ""}`} />
							<span>{isSaving ? "Saving..." : "Save"}</span>
						</button>
					)}
				</div>
			</div>

			{/* Path bar when file is open */}
			{currentFile && (
				<div className="h-8 bg-gray-800/50 border-b border-gray-700 flex items-center px-4">
					<span className="text-sm text-gray-400">
						{currentFile}
						{isDirty && <span className="text-yellow-500 ml-2">•</span>}
					</span>
				</div>
			)}

			{/* Main Content */}
			<div className="flex-1 overflow-hidden">
				<Allotment>
					{/* File Explorer */}
					<Allotment.Pane preferredSize="20%" minSize={200}>
						<div className="w-full h-full bg-gray-800 text-white">
							<div className="p-4 border-b border-gray-700 flex items-center space-x-2">
								<FolderOpen className="h-5 w-5 text-blue-400" />
								<h2 className="font-medium">Explorer</h2>
							</div>
							<div className="p-2">
								<FileExplorer files={fileTree} onCreateFile={handleCreateFile} onCreateDirectory={handleCreateDirectory} onDeletePath={handleDeletePath} onSelectFile={handleSelectFile} selectedFile={currentFile} />
							</div>
						</div>
					</Allotment.Pane>

					{/* Editor and Terminal */}
					<Allotment vertical>
						{/* Editor */}
						<Allotment.Pane>
							<div className="h-full bg-gray-900">
								{currentFile ? (
									<Editor
										defaultLanguage="javascript"
										theme="vs-dark"
										value={fileContent}
										onChange={handleEditorChange}
										path={currentFile}
										options={{
											minimap: { enabled: false },
											fontFamily: "'JetBrains Mono', monospace",
											fontSize: 14,
											lineHeight: 1.6,
											padding: { top: 16 },
											scrollBeyondLastLine: false,
										}}
									/>
								) : (
									<div className="h-full flex items-center justify-center">
										<div className="max-w-md p-6 text-center rounded-lg bg-gray-800 border border-gray-700">
											<Code className="h-12 w-12 text-blue-400 mx-auto mb-4" />
											<h3 className="text-lg font-medium text-white mb-2">Welcome to Web IDE</h3>
											<p className="text-gray-400">Select a file from the explorer to start editing</p>
										</div>
									</div>
								)}
							</div>
						</Allotment.Pane>

						{/* Terminal */}
						<Allotment.Pane minSize={150} preferredSize="30%">
							<div className="h-full bg-gray-900">
								<div className="p-2 border-t border-gray-700 bg-gray-800 flex items-center space-x-2">
									<TerminalIcon className="h-4 w-4 text-blue-400" />
									<h3 className="text-sm font-medium text-gray-300">Terminal</h3>
								</div>
								<Terminal onCommand={sendCommand} output={output} />
							</div>
						</Allotment.Pane>
					</Allotment>
				</Allotment>
			</div>
		</div>
	);
}
