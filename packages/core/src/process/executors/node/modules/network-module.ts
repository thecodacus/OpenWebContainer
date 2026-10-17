import { QuickJSContext, QuickJSHandle } from "quickjs-emscripten"
interface SocketEventHandlers {
    data: Array<(chunk: string) => void>
    end: Array<() => void>
    close: Array<() => void>
    error: Array<(error: Error) => void>
}

interface Socket {
    id: string
    eventHandlers: SocketEventHandlers
    remoteAddress: string
    remotePort: number
    localAddress: string
    localPort: number
    destroyed: boolean
}

export interface HostRequest {
    method?: string
    url?: string
    path?: string
    hostname?: string
    port?: number
    headers?: Record<string, string>
    body?: string
}

interface ResponseEventHandlers {
    data: Array<(chunk: string) => void>
    end: Array<() => void>
}

export class NetworkModule {
    private servers: Map<string, {
        host: string,
        port: number,
        requestHandler?: (reqObj: QuickJSHandle, resObj: QuickJSHandle) => any,
        connectionCallback?: QuickJSHandle | null
    }> = new Map()
    private sockets: Map<string, Socket> = new Map()
    private context: QuickJSContext
    private nextSocketId: number = 1
    private debug: boolean = false
    private onServerListen: (port: number) => void
    private onServerCrash: (port: number) => void
    private onServerClose: (port: number) => void

    constructor(context: QuickJSContext, onServerListen: (port: number) => void,onServerClose: (port: number) => void, debug: boolean = false) {
        this.context = context
        this.debug = debug
        this.onServerListen = onServerListen
        this.onServerClose = onServerClose
        this.onServerCrash = onServerClose
    }

    private log(scope: string, message: string, data?: any) {
        if (!this.debug) return
        const timestamp = new Date().toISOString()
        if (data) {
            console.log(`[${timestamp}] [NetworkSystem:${scope}] ${message}`, data)
        } else {
            console.log(`[${timestamp}] [NetworkSystem:${scope}] ${message}`)
        }
    }

    createNetModule(): QuickJSHandle {
        this.log('createNetModule', 'Creating network module')
        const netModule = this.context.newObject()

        // Create TCP server
        const createServerHandle = this.context.newFunction("createServer", (optionsOrCallback: QuickJSHandle) => {
            this.log('createServer', 'Creating new TCP server')
            const serverObj = this.context.newObject()
            let connectionCallback: QuickJSHandle | null = null

            if (this.context.typeof(optionsOrCallback) === 'function') {
                connectionCallback = optionsOrCallback
            }

            const listenHandle = this.context.newFunction("listen", (portHandle, hostHandle, backlogOrCallback) => {
                const port = this.context.getNumber(portHandle)
                const host = (hostHandle && hostHandle !== this.context.undefined)
                    ? this.context.getString(hostHandle)
                    : 'localhost'

                this.log('listen', `Server listening on ${host}:${port}`)

                let callback = backlogOrCallback
                if (this.context.typeof(hostHandle) === 'function') {
                    callback = hostHandle
                }

                this.servers.set(`${host}:${port}`, {
                    port,
                    host,
                    connectionCallback
                })

                if (callback && callback !== this.context.undefined) {
                    this.context.callFunction(callback, serverObj, [])
                }
                this.onServerListen(port)

                return serverObj
            })
            this.context.setProp(serverObj, "listen", listenHandle)
            listenHandle.dispose()

            const closeHandle = this.context.newFunction("close", (callbackHandle) => {
                this.log('close', 'Closing TCP server')
                const serverKey = Array.from(this.servers.entries())
                    .find(([_, server]) => server.connectionCallback === connectionCallback)?.[0]

                if (serverKey) {
                    this.servers.delete(serverKey)
                }

                if (callbackHandle && callbackHandle !== this.context.undefined) {
                    this.context.callFunction(callbackHandle, serverObj, [])
                }

                return serverObj
            })
            this.context.setProp(serverObj, "close", closeHandle)
            closeHandle.dispose()

            return serverObj
        })

        this.context.setProp(netModule, "createServer", createServerHandle)
        createServerHandle.dispose()

        const connectHandle = this.context.newFunction("connect", (options, connectListener) => {
            const opts = this.context.dump(options) as any
            const port = typeof opts === 'number' ? opts : opts.port
            const host = typeof opts === 'string' ? opts : (opts.host || 'localhost')
            const serverKey = `${host}:${port}`

            this.log('connect', `Attempting connection to ${serverKey}`)

            const server = this.servers.get(serverKey)
            if (!server) {
                throw new Error(`Cannot connect to ${serverKey}: no server listening`)
            }

            const { socketObj: clientSocket, socket: clientSocketData } = this.createSocketObj(
                host,
                port,
                'localhost',
                49152 + Math.floor(Math.random() * 16384)
            )

            const { socketObj: serverSocket, socket: serverSocketData } = this.createSocketObj(
                'localhost',
                clientSocketData.localPort,
                host,
                port
            )

            // Link sockets bidirectionally
            this.linkSockets(clientSocketData, serverSocketData)
            this.linkSockets(serverSocketData, clientSocketData)

            if (server.connectionCallback) {
                this.log('connect', 'Calling server connection callback')
                this.context.callFunction(server.connectionCallback, this.context.undefined, [serverSocket])
            }

            if (connectListener && connectListener !== this.context.undefined) {
                this.context.callFunction(connectListener, clientSocket, [])
            }

            serverSocket.dispose()
            return clientSocket
        })

        this.context.setProp(netModule, "connect", connectHandle)
        this.context.setProp(netModule, "createConnection", connectHandle)
        connectHandle.dispose()

        return netModule
    }

    private linkSockets(source: Socket, target: Socket) {
        this.log('linkSockets', `Linking socket ${source.id} to ${target.id}`)
        source.eventHandlers.data = source.eventHandlers.data.concat(
            (data: string) => target.eventHandlers.data.forEach(h => h(data))
        )
        source.eventHandlers.end = source.eventHandlers.end.concat(
            () => target.eventHandlers.end.forEach(h => h())
        )
        source.eventHandlers.close = source.eventHandlers.close.concat(
            () => target.eventHandlers.close.forEach(h => h())
        )
        source.eventHandlers.error = source.eventHandlers.error.concat(
            (err: Error) => target.eventHandlers.error.forEach(h => h(err))
        )
    }

    createHttpModule(): QuickJSHandle {
        this.log('createHttpModule', 'Creating HTTP module')
        const httpModule = this.context.newObject()

        const createServerHandle = this.context.newFunction("createServer", (handlerHandle) => {
            this.log('createHttpServer', 'Creating new HTTP server')
            const serverObj = this.context.newObject()
            const serverHandlerHandle = handlerHandle.dup()
            let serverObjDup = serverObj.dup()
            let serverKey:string|undefined
            const listenHandle = this.context.newFunction("listen", (portHandle, callbackHandle) => {
                const port = this.context.getNumber(portHandle)
                const host = 'localhost'
                serverKey = `${host}:${port}`

                this.log('listen', `HTTP server listening on ${serverKey}`)

                this.servers.set(serverKey, {
                    port,
                    host,
                    requestHandler: (reqObjHandle: QuickJSHandle, resObjHandle: QuickJSHandle): any => {
                        this.log('requestHandler', 'Processing incoming HTTP request')
                        let reqObj = reqObjHandle.dup()
                        let resObj = resObjHandle.dup()

                        try {
                            let reqDup = reqObj.dup()
                            let resDup = resObj.dup()
                            let serverHandlerHandleDup = serverHandlerHandle.dup()
                            this.context.callFunction(serverHandlerHandleDup, this.context.undefined, [reqDup, resDup])
                        } catch (error) {
                            this.log('requestHandler', 'Error in request handler', error)
                            this.onServerCrash(port)
                        } finally {
                            reqObj.dispose()
                            resObj.dispose()
                        }
                    }
                })

                if (callbackHandle && callbackHandle !== this.context.undefined) {
                    try {
                        this.log('listen', 'Executing server listen callback')
                        let callbackHandleDup = callbackHandle.dup()
                        let serverObjCallbackDup = serverObjDup.dup()
                        this.context.callFunction(callbackHandleDup, serverObjCallbackDup.dup(), [])
                    } catch (error) {
                        this.log('listen', "Error Executing Listen Callback: ", error)
                    }
                }
                this.log('listen', 'Emit Server Registar Event')
                this.onServerListen(port)
                this.log('listen', 'Server Registar Event Emitted')
                this.log('listen', 'Returning server object')
                return serverObjDup
            })

            this.context.setProp(serverObj, "listen", listenHandle)
            listenHandle.dispose()

            const closeHandle = this.context.newFunction("close", (callbackHandle) => {
                if(serverKey==undefined){
                    this.log('close', 'Server Not started')
                    throw new Error('Server not started')
                }
                let server = this.servers.get(serverKey)
                if(server==undefined){
                    this.log('close', 'Server not found')
                    throw new Error('Server not found')
                }
                this.log('close', 'Closing HTTP server')
                serverHandlerHandle.dispose()

                if (callbackHandle && callbackHandle !== this.context.undefined) {
                    let callbackHandleDup = callbackHandle.dup()
                    let serverObjCallbackDup = serverObjDup.dup()
                    this.context.callFunction(callbackHandleDup, serverObjCallbackDup.dup(), [])
                }
                
                this.onServerClose(server.port)
                this.log('close', 'Returning server object')
                return serverObjDup
            })
            this.context.setProp(serverObj, "close", closeHandle)
            closeHandle.dispose()

            return serverObj
        })

        this.context.setProp(httpModule, "createServer", createServerHandle)
        createServerHandle.dispose()

        const requestHandle = this.context.newFunction("request", (reqObj, callbackHandle) => {
            const options: HostRequest = this.context.dump(reqObj) as any
            const serverKey = `${options.hostname || 'localhost'}:${options.port}`

            this.log('request', `Making HTTP request to ${serverKey}`, options)

            const server = this.servers.get(serverKey)
            if (!server) {
                this.log('request', `No server found at ${serverKey}`)
                const errorObj = this.context.newError(`No server listening on ${serverKey}`)
                this.context.callFunction(callbackHandle, this.context.undefined, [errorObj])
                errorObj.dispose()
                return
            }

            let { resObj: resObjHandle, eventHandlers } = this.makeRequestRespObj()
            const resObj = resObjHandle.dup()

            try {
                let resObjDup = resObj.dup()
                this.context.callFunction(callbackHandle, this.context.undefined, [resObjDup])
            } catch (error) {
                this.log('request', 'Error in request callback', error)
            }

            try {
                let resObjDup = resObj.dup()
                server.requestHandler?.(reqObj, resObjDup)
            } catch (error) {
                this.log('request', 'Error in server request handler', error)
            }
        })

        this.context.setProp(httpModule, "request", requestHandle)
        requestHandle.dispose()

        const exported = httpModule.dup()
        httpModule.dispose()
        return exported
    }

    private makeRequestRespObj() {
        this.log('makeRequestRespObj', 'Creating response object')
        const resObj = this.context.newObject()
        const eventHandlers: ResponseEventHandlers = {
            data: [],
            end: []
        }

        let resForHandlers = resObj.dup()

        const onHandle = this.context.newFunction("on", (eventHandle, listenerHandle) => {
            const event = this.context.getString(eventHandle)
            const resObjDup = resForHandlers.dup()
            const listenerHandleDup = listenerHandle.dup()

            if (event === 'data') {
                this.log('responseEvent', 'Attaching data handler')
                eventHandlers.data.push((chunk: string) => {
                    try {
                        const chunkHandle = this.context.newString(chunk)
                        this.context.callFunction(listenerHandleDup.dup(), resObjDup.dup(), [chunkHandle])
                        chunkHandle.dispose()
                    } catch (error) {
                        this.log('responseEvent', 'Error in data handler', error)
                    }
                })
            } else if (event === 'end') {
                this.log('responseEvent', 'Attaching end handler')
                eventHandlers.end.push(() => {
                    try {
                        this.context.callFunction(listenerHandleDup.dup(), resObjDup.dup(), [])
                    } catch (error) {
                        this.log('responseEvent', 'Error in end handler', error)
                    }
                })
            }
            return resObj
        })
        this.context.setProp(resObj, "on", onHandle)
        onHandle.dispose()

        let resObjDup = resObj.dup()
        const writeHeadHandle = this.context.newFunction("writeHead", (statusHandle, headersHandle) => {
            this.log('responseWrite', 'Setting response headers')
            const status = this.context.getNumber(statusHandle)
            const headers = this.context.dump(headersHandle)

            this.context.setProp(resObjDup, "statusCode", this.context.newNumber(status))
            const responseHeadersObj = this.context.newObject()
            for (const [key, value] of Object.entries(headers)) {
                this.context.setProp(responseHeadersObj, key, this.context.newString(value as string))
            }
            this.context.setProp(resObjDup, "headers", responseHeadersObj)
            responseHeadersObj.dispose()

            return resObjDup
        })
        this.context.setProp(resObj, "writeHead", writeHeadHandle)
        writeHeadHandle.dispose()

        const writeHandle = this.context.newFunction("write", (dataHandle) => {
            const chunk = this.context.getString(dataHandle)
            this.log('responseWrite', 'Writing response chunk')
            eventHandlers.data.forEach(handler => handler(chunk))
            return resObj.dup()
        })
        this.context.setProp(resObj, "write", writeHandle)
        writeHandle.dispose()

        const endHandle = this.context.newFunction("end", (dataHandle) => {
            this.log('responseEnd', 'Ending response')
            if (dataHandle) {
                const finalChunk = this.context.getString(dataHandle)
                eventHandlers.data.forEach(handler => handler(finalChunk))
            }
            eventHandlers.end.forEach(handler => handler())
            return resObj.dup()
        })
        this.context.setProp(resObj, "end", endHandle)
        endHandle.dispose()

        return { resObj, eventHandlers }
    }
    private createSocketObj(
        remoteAddress: string,
        remotePort: number,
        localAddress: string,
        localPort: number
    ): { socketObj: QuickJSHandle, socket: Socket } {
        const socketId = `socket_${this.nextSocketId++}`
        const socketObj = this.context.newObject()

        // Initialize socket data
        const socket: Socket = {
            id: socketId,
            eventHandlers: {
                data: [],
                end: [],
                close: [],
                error: []
            },
            remoteAddress,
            remotePort,
            localAddress,
            localPort,
            destroyed: false
        }

        this.sockets.set(socketId, socket)

        // Add socket properties
        this.context.setProp(socketObj, "remoteAddress", this.context.newString(remoteAddress))
        this.context.setProp(socketObj, "remotePort", this.context.newNumber(remotePort))
        this.context.setProp(socketObj, "localAddress", this.context.newString(localAddress))
        this.context.setProp(socketObj, "localPort", this.context.newNumber(localPort))

        // Add socket methods
        const onHandle = this.context.newFunction("on", (eventHandle, listenerHandle) => {
            const event = this.context.getString(eventHandle)

            switch (event) {
                case 'data':
                    socket.eventHandlers.data.push((chunk: string) => {
                        const chunkHandle = this.context.newString(chunk)
                        this.context.callFunction(listenerHandle, socketObj, [chunkHandle])
                        chunkHandle.dispose()
                    })
                    break
                case 'end':
                    socket.eventHandlers.end.push(() => {
                        this.context.callFunction(listenerHandle, socketObj, [])
                    })
                    break
                case 'close':
                    socket.eventHandlers.close.push(() => {
                        this.context.callFunction(listenerHandle, socketObj, [])
                    })
                    break
                case 'error':
                    socket.eventHandlers.error.push((error: Error) => {
                        const errorHandle = this.context.newError(error.message)
                        this.context.callFunction(listenerHandle, socketObj, [errorHandle])
                        errorHandle.dispose()
                    })
                    break
            }
            return socketObj
        })
        this.context.setProp(socketObj, "on", onHandle)
        onHandle.dispose()

        // Write method
        const writeHandle = this.context.newFunction("write", (dataHandle, encodingHandle, callbackHandle) => {
            const data = this.context.getString(dataHandle)

            // Simulate some basic backpressure
            const highWaterMark = 16384 // 16KB
            const shouldApplyBackpressure = data.length > highWaterMark

            // Schedule the write asynchronously
            setTimeout(() => {
                socket.eventHandlers.data.forEach(handler => handler(data))
                if (callbackHandle && callbackHandle !== this.context.undefined) {
                    this.context.callFunction(callbackHandle, socketObj, [])
                }
            }, 0)

            return (!shouldApplyBackpressure) ? this.context.true : this.context.false
        })
        this.context.setProp(socketObj, "write", writeHandle)
        writeHandle.dispose()

        // End method
        const endHandle = this.context.newFunction("end", (dataHandle) => {
            if (dataHandle && dataHandle !== this.context.undefined) {
                const finalData = this.context.getString(dataHandle)
                socket.eventHandlers.data.forEach(handler => handler(finalData))
            }

            socket.eventHandlers.end.forEach(handler => handler())
            socket.eventHandlers.close.forEach(handler => handler())
            socket.destroyed = true

            return socketObj
        })
        this.context.setProp(socketObj, "end", endHandle)
        endHandle.dispose()

        // Destroy method
        const destroyHandle = this.context.newFunction("destroy", (errorHandle) => {
            if (errorHandle && errorHandle !== this.context.undefined) {
                const error = new Error(this.context.getString(errorHandle))
                socket.eventHandlers.error.forEach(handler => handler(error))
            }

            socket.destroyed = true
            socket.eventHandlers.close.forEach(handler => handler())
            this.sockets.delete(socketId)

            return socketObj
        })
        this.context.setProp(socketObj, "destroy", destroyHandle)
        destroyHandle.dispose()

        return { socketObj, socket }
    }

    public static hostRequestToHandle(context: QuickJSContext, request: HostRequest): QuickJSHandle {
        const newRequestOptions: HostRequest = {
            method: request.method || 'GET',
            hostname: request.hostname || 'localhost',
            path: request.path || "",
            port: request.port || 80,
            headers: request.headers || {},
            body: request.body
        }
        newRequestOptions.url = `http://${newRequestOptions.hostname}:${newRequestOptions.port}${newRequestOptions.path}`

        const reqHandle = context.newObject()

        try {
            for (const [key, value] of Object.entries(newRequestOptions)) {
                if (value === undefined) continue

                if (key === 'headers' && typeof value === 'object') {
                    const headersHandle = context.newObject()
                    for (const [headerKey, headerValue] of Object.entries(value)) {
                        const valueHandle = context.newString(headerValue as string)
                        context.setProp(headersHandle, headerKey, valueHandle)
                        valueHandle.dispose()
                    }
                    context.setProp(reqHandle, key, headersHandle)
                    headersHandle.dispose()
                } else {
                    const valueHandle = typeof value === 'string'
                        ? context.newString(value)
                        : typeof value === 'number'
                            ? context.newNumber(value)
                            : context.newString(JSON.stringify(value))
                    context.setProp(reqHandle, key, valueHandle)
                    valueHandle.dispose()
                }
            }

            return reqHandle
        } catch (error) {
            reqHandle.dispose()
            throw error
        }
    }

    dispose() {
        this.log('dispose', 'Disposing network system')
        this.servers.clear()
        this.sockets.clear()
    }
}

// Helper function to make requests from host to QuickJS server
export async function makeRequest(
    context: QuickJSContext,
    options: {
        hostname?: string
        port: number
        path?: string
        method?: string
        headers?: Record<string, string>
        debug?: boolean
    }
): Promise<string> {
    const debug = options.debug ?? false
    const log = (message: string, data?: any) => {
        if (!debug) return
        const timestamp = new Date().toISOString()
        if (data) {
            console.log(`[${timestamp}] [makeRequest] ${message}`, data)
        } else {
            console.log(`[${timestamp}] [makeRequest] ${message}`)
        }
    }

    return new Promise((resolve, reject) => {
        try {
            log('Creating request', options)
            let reqObj = NetworkModule.hostRequestToHandle(context, {
                hostname: options.hostname,
                port: options.port,
                path: options.path,
                method: options.method,
                headers: options.headers
            })

            const callbackHandle = context.newFunction("callback", (resHandle) => {
                try {
                    log('Response received, setting up event handlers')
                    let responseData = ''
                    let resObj = resHandle.dup()
                    const onHandle = context.getProp(resObj, "on")

                    const dataListenerHandle = context.newFunction("dataListener", (chunkHandle) => {
                        const chunk = context.getString(chunkHandle)
                        log('Received data chunk', { length: chunk.length })
                        responseData += chunk
                    })

                    const endListenerHandle = context.newFunction("endListener", () => {
                        log('Response complete', { responseLength: responseData.length })
                        resolve(responseData)
                        dataListenerHandle.dispose()
                        endListenerHandle.dispose()
                    })

                    let resObjDataDup = resObj.dup()
                    context.callFunction(onHandle, resObjDataDup, [
                        context.newString("data"),
                        dataListenerHandle
                    ])

                    let resObjEndDup = resObj.dup()
                    context.callFunction(onHandle, resObjEndDup, [
                        context.newString("end"),
                        endListenerHandle
                    ])

                    onHandle.dispose()
                } catch (error) {
                    log('Error in response callback', error)
                    reject(error)
                }
            })

            log('Initiating request')
            const httpHandle = context.getProp(context.global, "http")
            const requestHandle = context.getProp(httpHandle, "request")

            context.callFunction(requestHandle, context.undefined, [reqObj, callbackHandle])

            // Cleanup handles
            requestHandle.dispose()
            httpHandle.dispose()
            callbackHandle.dispose()
            reqObj.dispose()

        } catch (error) {
            log('Error making request', error)
            reject(error)
        }
    })
}

export const  statusCodeToStatusText = (statusCode: number) => { 
    switch (statusCode) {
        case 100: return 'Continue';
        case 101: return 'Switching Protocols';
        case 102: return 'Processing';
        case 200: return 'OK';
        case 201: return 'Created';
        case 202: return 'Accepted';
        case 203: return 'Non-Authoritative Information';
        case 204: return 'No Content';
        case 205: return 'Reset Content';
        case 206: return 'Partial Content';
        case 207: return 'Multi-Status';
        case 208: return 'Already Reported';
        case 226: return 'IM Used';
        case 300: return 'Multiple Choices';
        case 301: return 'Moved Permanently';
        case 302: return 'Found';
        case 303: return 'See Other';
        case 304: return 'Not Modified';
        case 305: return 'Use Proxy';
        case 307: return 'Temporary Redirect';
        case 308: return 'Permanent Redirect';
        case 400: return 'Bad Request';
        case 401: return 'Unauthorized';
        case 402: return 'Payment Required';
        case 403: return 'Forbidden';
        case 404: return 'Not Found';
        case 405: return 'Method Not Allowed';
        case 406: return 'Not Acceptable';
        case 407: return 'Proxy Authentication Required';
        case 408: return 'Request Timeout';
        case 409: return 'Conflict';
        case 410: return 'Gone';
        case 411: return 'Length Required';
        case 412: return 'Precondition Failed';
        case 413: return 'Payload Too Large';
        case 414: return 'URI Too Long';
        case 415: return 'Unsupported Media Type';
        case 416: return 'Range Not Satisfiable';
        case 417: return 'Expectation Failed';
        case 418: return 'I\'m a teapot';
        case 421: return 'Misdirected Request';
        case 422: return 'Unprocessable Entity';
        case 423: return 'Locked';
        case 424: return 'Failed Dependency';
        case 426: return 'Upgrade Required';
        case 428: return 'Precondition Required';
        case 429: return 'Too Many Requests';
        case 431: return 'Request Header Fields Too Large';
        case 451: return 'Unavailable For Legal Reasons';
        case 500: return 'Internal Server Error';
        case 501: return 'Not Implemented';
        case 502: return 'Bad Gateway';
        case 503: return 'Service Unavailable';
        case 504: return 'Gateway Timeout';
        case 505: return 'HTTP Version Not Supported';
        case 506: return 'Variant Also Negotiates';
        case 507: return 'Insufficient Storage';
        case 508: return 'Loop Detected';
        case 510: return 'Not Extended';
        case 511: return 'Network Authentication Required';
        default: return 'Unknown Status Code';
    }
}
