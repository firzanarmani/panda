import { Builder } from '@pandacss/node'
import { type Connection, DidChangeConfigurationNotification, TextDocuments } from 'vscode-languageserver'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { serverCapabilities } from './capabilities'
import { type PandaVSCodeSettings, defaultSettings, getFlattenedSettings } from '@pandacss/extension-shared'
import glob from 'fast-glob'
import { uriToPath } from './uri-to-path'
import { BuilderResolver } from './builder-resolver'

const builderResolver = new BuilderResolver()

const ref = {
  settings: null as PandaVSCodeSettings | null,
  /**
   * current builder's context, used by most features as we can only be in one context at a time
   * depending on the active document
   */
  context: null as unknown as Builder['context'],
  synchronizing: false as Promise<void> | false,
  //
  activeDocumentFilepath: '',
}

let hasConfigurationCapability = false
let hasWorkspaceFolderCapability = false

/**
 * Setup builder
 * - panda.config detection & context loading
 * - reload on panda.config change
 * - make the builder.setup promise shared so it can be awaited by multiple features
 */
export function setupBuilder(
  connection: Connection,
  documents: TextDocuments<TextDocument>,
  {
    onDidChangeConfiguration,
    onReady,
  }: {
    onReady: () => void
    onDidChangeConfiguration: (settings: PandaVSCodeSettings) => void
  },
) {
  builderResolver.onSetup(({ configPath }) => {
    const builder = builderResolver.get(configPath)
    if (!builder) return

    const ctx = builder.context
    if (!ctx) return

    const tokenNames = Array.from(new Set(ctx.tokens.allTokens.map((token) => token.path.slice(1).join('.'))))
    connection.sendNotification('$/panda-token-names', { configPath, tokenNames })
  })

  async function setupWorkspaceBuilders(rootPath: string) {
    console.log('🐼 Setup workspace builders...')
    const configPathList = await glob(`${rootPath}/**/panda.config.{ts,cts,mts,js,cjs,mjs}`, {
      cwd: rootPath,
      onlyFiles: true,
      absolute: true,
      ignore: ['**/node_modules/**'],
    })

    await Promise.all(
      configPathList.map(async (configPath) => {
        try {
          console.log('💼 Config setup at:', configPath)
          await builderResolver.create(configPath).setup(configPath)
          console.log('✅ Config setup done:', configPath)
        } catch (err) {
          // Ignore
          console.log('❌ Config setup failed!', configPath, err)
        }
      }),
    )
    console.log('🐼 Workspaces builders ready !')

    if (configPathList.length === 1) {
      return builderResolver.isContextSynchronizing(configPathList[0])
    }
  }

  async function loadPandaContext(uriOrFilepath: string) {
    const filepath = uriToPath(uriOrFilepath) ?? uriOrFilepath

    try {
      console.log('🚧 Loading context for:', filepath)
      ref.synchronizing = builderResolver.setup(filepath)
      await ref.synchronizing
      console.log('✅ Loading context done:', filepath)
    } catch (err) {
      // Ignore
      ref.synchronizing = false
      console.log('❌ Loading context failed!', err)
      return
    }

    ref.synchronizing = false

    const builder = builderResolver.get(filepath)
    if (!builder || !builder.context) return

    ref.context = builder.context

    return ref.context
  }

  function getClosestPandaContext(uri: string) {
    const filepath = uriToPath(uri) ?? uri

    const builder = builderResolver.get(filepath)
    if (!builder || !builder.context) return

    ref.context = builder.context

    return ref.context
  }

  const getFreshPandaSettings = async () => {
    return getFlattenedSettings((await connection.workspace.getConfiguration('panda')) ?? defaultSettings)
  }

  /**
   * Resolve current extension settings
   */
  async function getPandaSettings(): Promise<PandaVSCodeSettings>
  async function getPandaSettings<Key extends keyof PandaVSCodeSettings>(key: Key): Promise<PandaVSCodeSettings[Key]>
  async function getPandaSettings<Key extends keyof PandaVSCodeSettings>(key?: Key) {
    const getter = (settings: PandaVSCodeSettings) => {
      return key ? settings[key] : settings
    }

    if (!hasConfigurationCapability) {
      return getter(defaultSettings)
    }

    if (!ref.settings) {
      ref.settings = await getFreshPandaSettings()
    }

    return getter(ref.settings ?? defaultSettings)
  }

  connection.onInitialize((params) => {
    connection.console.log('🤖 Starting PandaCss LSP...')

    const capabilities = params.capabilities

    const { activeDocumentFilepath } = params.initializationOptions as { activeDocumentFilepath: string | undefined }
    if (activeDocumentFilepath) {
      ref.activeDocumentFilepath = activeDocumentFilepath
      console.log('📄 Init Active document:', activeDocumentFilepath)
    }

    // Check context support
    hasConfigurationCapability = !!(capabilities.workspace && !!capabilities.workspace.configuration)
    hasWorkspaceFolderCapability = !!(capabilities.workspace && !!capabilities.workspace.workspaceFolders)

    connection.onInitialized(async () => {
      connection.console.log('⚡ Connection initialized!')

      if (hasConfigurationCapability) {
        // Register for all configuration changes.
        connection.client.register(DidChangeConfigurationNotification.type, undefined)

        ref.settings = await getFreshPandaSettings()
        onDidChangeConfiguration(ref.settings)
      }

      if (hasWorkspaceFolderCapability) {
        connection.workspace.onDidChangeWorkspaceFolders((_event) =>
          connection.console.log('Workspace folder change event received.'),
        )
      }

      const workspaceFolders = await connection.workspace.getWorkspaceFolders()
      const validFolders = workspaceFolders?.map((folder) => uriToPath(folder.uri) || '').filter((path) => !!path)

      console.log('📁 Workspace folders:', validFolders)
      await Promise.all(validFolders?.map((folder) => setupWorkspaceBuilders(folder)) ?? [])

      onReady()
      connection.sendNotification('$/panda-lsp-ready')

      if (activeDocumentFilepath) {
        const ctx = getClosestPandaContext(activeDocumentFilepath)

        if (ctx) {
          connection.console.log(`🐼 Found panda context! ✅ at ${ctx.path}`)
        }
      }
    })

    return { capabilities: serverCapabilities }
  })

  connection.onNotification('$/panda-active-document-changed', (params) => {
    console.log('📄 Active document:', ref.activeDocumentFilepath)
    ref.activeDocumentFilepath = params.activeDocumentFilepath

    const configPath = builderResolver.findConfigDirpath(ref.activeDocumentFilepath, (_, configPath) => configPath)
    if (!configPath) return

    connection.sendNotification('$/panda-doc-config-path', {
      activeDocumentFilepath: ref.activeDocumentFilepath,
      configPath,
    })
  })

  connection.onRequest('$/get-config-path', ({ activeDocumentFilepath }: { activeDocumentFilepath: string }) => {
    activeDocumentFilepath ??= ref.activeDocumentFilepath
    if (!activeDocumentFilepath) return

    return builderResolver.findConfigDirpath(activeDocumentFilepath, (_, configPath) => {
      console.log('config path', configPath)
      return configPath
    })
  })

  connection.onDidChangeConfiguration(async (_change) => {
    connection.console.log('⌛ onDidChangeConfiguration')

    if (hasConfigurationCapability) {
      ref.settings = await getFreshPandaSettings()
      console.log('🐼 Settings changed!', ref.settings)
      onDidChangeConfiguration(ref.settings)
    }
  })

  connection.onDidChangeWatchedFiles(async ({ changes }) => {
    changes.forEach(async (fileEvent) => {
      const filepath = uriToPath(fileEvent.uri) ?? fileEvent.uri
      connection.console.log('🔃 Reloading panda context for:' + filepath)
      await builderResolver.setup(filepath)
    })
  })

  documents.listen(connection)
  connection.listen()

  return {
    getPandaSettings,
    loadPandaContext,
    getContext() {
      return ref.context
    },
    isSynchronizing() {
      return ref.synchronizing
    },
  }
}

export type PandaExtensionSetup = ReturnType<typeof setupBuilder>
