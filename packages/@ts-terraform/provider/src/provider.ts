import execa from 'execa'
import {TextDecoder, TextEncoder} from 'util'
import {tfplugin5} from '../generated/client'
import {
  fromDynamic,
  Kind,
  optionalsToNulls,
  tfSchemasRecordToSchemaTypeRecord,
  tfSchemaToSchemaType,
  toDynamic,
  toRawState,
} from './cty-types'
import {throwDiagnosticErrors} from './errors'
import {newRPC} from './rpc'
import {asCode, ObjectProperties, ObjectType, StringKeyOf, T, validateOrThrow} from './type-system'

const decoder = new TextDecoder()
const encoder = new TextEncoder()

export interface Options {
  /** If true, the provider's debug messages will be printed on stderr */
  debug?: boolean
}

interface Internals {
  rpc: tfplugin5.Provider
  subprocess: execa.ExecaChildProcess
  schema: tfplugin5.GetProviderSchema.Response
}

export interface ProviderConfigType {
  providerSchema: object
  dataSourceSchemas: Record<string, object>
  resourceSchemas: Record<string, object>
  dataSourceStateSchemas: Record<string, object>
  resourceStateSchemas: Record<string, object>
}

export class Provider<
  ProviderConfig extends ProviderConfigType = {
    dataSourceSchemas: {}
    providerSchema: {}
    resourceSchemas: {}
    dataSourceStateSchemas: {}
    resourceStateSchemas: {}
  }
> {
  #rpc: tfplugin5.Provider
  #subprocess: execa.ExecaChildProcess

  #providerSchema: ObjectType<ObjectProperties>

  #dataSourceSchemas: Record<string, ObjectType<ObjectProperties>>
  #resourceSchemas: Record<string, ObjectType<ObjectProperties>>

  #dataSourceStateSchemas: Record<string, ObjectType<ObjectProperties>>
  #resourceStateSchemas: Record<string, ObjectType<ObjectProperties>>

  constructor({rpc, subprocess, schema}: Internals) {
    this.#rpc = rpc
    this.#subprocess = subprocess

    if (!schema.provider || !schema.provider.block) {
      throw new Error('Unable to read provider schema')
    }

    this.#providerSchema = tfSchemaToSchemaType(schema.provider, Kind.ARGS)

    this.#dataSourceSchemas = tfSchemasRecordToSchemaTypeRecord(schema.dataSourceSchemas, Kind.ARGS)
    this.#resourceSchemas = tfSchemasRecordToSchemaTypeRecord(schema.resourceSchemas, Kind.ARGS)

    this.#dataSourceStateSchemas = tfSchemasRecordToSchemaTypeRecord(schema.dataSourceSchemas, Kind.ATTRS)
    this.#resourceStateSchemas = tfSchemasRecordToSchemaTypeRecord(schema.resourceSchemas, Kind.ATTRS)
  }

  get providerSchema(): ObjectType<ObjectProperties> {
    return this.#providerSchema
  }

  get dataSourceSchemas(): Record<string, ObjectType<ObjectProperties>> {
    return this.#dataSourceSchemas
  }

  get resourceSchemas(): Record<string, ObjectType<ObjectProperties>> {
    return this.#resourceSchemas
  }

  get dataSourceStateSchemas(): Record<string, ObjectType<ObjectProperties>> {
    return this.#dataSourceStateSchemas
  }

  get resourceStateSchemas(): Record<string, ObjectType<ObjectProperties>> {
    return this.#resourceStateSchemas
  }

  async getSchema(): Promise<tfplugin5.GetProviderSchema.Response> {
    return this.#rpc.getSchema({}).then(throwDiagnosticErrors)
  }

  async applyResourceChange<Name extends StringKeyOf<ProviderConfig['resourceStateSchemas']>>(
    typeName: Name,
    priorState: ProviderConfig['resourceStateSchemas'][Name],
    plannedState: ProviderConfig['resourceStateSchemas'][Name],
    options: {private?: Record<string, unknown>} = {},
  ): Promise<{
    newState: ProviderConfig['resourceStateSchemas'][Name]
    private: Record<string, unknown>
  }> {
    const privateData = options.private ? {priorPrivate: encoder.encode(JSON.stringify(options.private))} : {}
    const res = await this.#rpc
      .applyResourceChange({
        typeName,
        priorState: toDynamic(priorState),
        plannedState: toDynamic(plannedState),
        ...privateData,
      })
      .then(throwDiagnosticErrors)

    const newState = fromDynamic<ProviderConfig['resourceStateSchemas'][Name]>(res.newState)
    if (!newState) {
      throw new Error('Unable to read planned state')
    }

    return {
      newState,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      private: JSON.parse(decoder.decode(res.private)) ?? {},
    }
  }

  async configure(config: ProviderConfig['providerSchema']): Promise<tfplugin5.Configure.Response> {
    validateOrThrow(this.#providerSchema, config)

    const {preparedConfig}: tfplugin5.PrepareProviderConfig.Response = await this.#rpc
      .prepareProviderConfig({config: toDynamic(optionalsToNulls(config, this.#providerSchema))})
      .then(throwDiagnosticErrors)

    if (!preparedConfig) {
      throw new Error('Unable to prepare provider config')
    }

    return await this.#rpc.configure({config: preparedConfig}).then(throwDiagnosticErrors)
  }

  async importResourceState<Name extends StringKeyOf<ProviderConfig['resourceStateSchemas']>>(
    typeName: Name,
    id: string,
  ): Promise<
    {typeName: Name; state: ProviderConfig['resourceStateSchemas'][Name]; private?: Record<string, unknown>}[]
  > {
    const res = await this.#rpc.importResourceState({typeName, id}).then(throwDiagnosticErrors)
    return res.importedResources.map((importedResource) => {
      if (importedResource.typeName == null) {
        throw new Error('Unable to read type name')
      }

      const state = fromDynamic<ProviderConfig['resourceStateSchemas'][Name]>(importedResource.state)
      if (!state) {
        throw new Error('Unable to read state')
      }

      return {
        typeName: importedResource.typeName as Name,
        state,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        private: importedResource.private != null ? JSON.parse(decoder.decode(importedResource.private)) ?? {} : {},
      }
    })
  }

  async planResourceChange<Name extends StringKeyOf<ProviderConfig['resourceStateSchemas']>>(
    typeName: Name,
    priorState: ProviderConfig['resourceStateSchemas'][Name],
    proposedNewState: ProviderConfig['resourceStateSchemas'][Name],
    options: {private?: Record<string, unknown>} = {},
  ): Promise<{
    plannedState: ProviderConfig['resourceStateSchemas'][Name]
    plannedPrivate: Record<string, unknown>
    requiresReplace: tfplugin5.IAttributePath[]
  }> {
    const resourceSchema: ObjectType<ObjectProperties> | undefined = this.#resourceStateSchemas[typeName]

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (resourceSchema === undefined) throw new TypeError(`Invalid resource type ${typeName}`)

    const privateData = options.private ? {priorPrivate: encoder.encode(JSON.stringify(options.private))} : {}
    const res = await this.#rpc
      .planResourceChange({
        typeName,
        priorState: toDynamic(priorState),
        proposedNewState: toDynamic(proposedNewState),
        ...privateData,
      })
      .then(throwDiagnosticErrors)

    const plannedState = fromDynamic<ProviderConfig['resourceStateSchemas'][Name]>(res.plannedState)
    if (!plannedState) {
      throw new Error('Unable to read planned state')
    }

    return {
      plannedState,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      plannedPrivate: JSON.parse(decoder.decode(res.plannedPrivate)) ?? {},
      requiresReplace: res.requiresReplace,
    }
  }

  async readDataSource<Name extends StringKeyOf<ProviderConfig['dataSourceSchemas']>>(
    typeName: Name,
    config: ProviderConfig['dataSourceSchemas'][Name],
  ): Promise<ProviderConfig['dataSourceStateSchemas'][Name]> {
    const dataSourceSchema: ObjectType<ObjectProperties> | undefined = this.#dataSourceSchemas[typeName]

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (dataSourceSchema === undefined) throw new TypeError(`Invalid data source type ${typeName}`)

    validateOrThrow(dataSourceSchema, config)

    const dynamicConfig = toDynamic(optionalsToNulls(config, dataSourceSchema))
    const res = await this.#rpc.readDataSource({typeName, config: dynamicConfig}).then(throwDiagnosticErrors)
    const state = fromDynamic<ProviderConfig['dataSourceStateSchemas'][Name]>(res.state)
    if (!state) {
      throw new Error('Unable to read state from data source')
    }
    return state
  }

  async readResource<Name extends StringKeyOf<ProviderConfig['resourceStateSchemas']>>(
    typeName: Name,
    currentState: ProviderConfig['resourceStateSchemas'][Name],
    options: {private?: Record<string, unknown>} = {},
  ): Promise<ProviderConfig['resourceStateSchemas'][Name] | undefined> {
    const resourceSchema: ObjectType<ObjectProperties> | undefined = this.#resourceStateSchemas[typeName]

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (resourceSchema === undefined) throw new TypeError(`Invalid resource type ${typeName}`)

    // TODO: should we enable this validator? (will conflict with `null` values)
    // validateOrThrow(resourceSchema, currentState)

    const privateData = options.private ? {private: encoder.encode(JSON.stringify(options.private))} : {}
    const res = await this.#rpc
      .readResource({typeName, currentState: toDynamic(currentState), ...privateData})
      .then(throwDiagnosticErrors)

    const state = fromDynamic<ProviderConfig['resourceStateSchemas'][Name]>(res.newState)
    return state ?? undefined
  }

  async shutdown(signal?: NodeJS.Signals | number): Promise<boolean> {
    return this.#subprocess.kill(signal)
  }

  async upgradeResourceState<Name extends StringKeyOf<ProviderConfig['resourceStateSchemas']>>(
    typeName: Name,
    version: number,
    state: object,
  ): Promise<ProviderConfig['resourceStateSchemas'][Name]> {
    const res = await this.#rpc
      .upgradeResourceState({typeName, version, rawState: toRawState(state)})
      .then(throwDiagnosticErrors)

    const upgradedState = fromDynamic<ProviderConfig['resourceStateSchemas'][Name]>(res.upgradedState)
    if (!upgradedState) {
      throw new Error('Unable to upgrade resource state')
    }

    return upgradedState
  }

  async validateDataSourceConfig<Name extends StringKeyOf<ProviderConfig['dataSourceSchemas']>>(
    typeName: Name,
    config: object,
  ): Promise<tfplugin5.ValidateDataSourceConfig.Response> {
    return await this.#rpc.validateDataSourceConfig({typeName, config: toDynamic(config)})
  }

  async validateResourceTypeConfig<Name extends StringKeyOf<ProviderConfig['resourceSchemas']>>(
    typeName: Name,
    config: object,
  ): Promise<tfplugin5.ValidateResourceTypeConfig.Response> {
    return await this.#rpc.validateResourceTypeConfig({typeName, config: toDynamic(config)})
  }
}

export function createProviderFactory<ProviderConfig extends ProviderConfigType>(): (
  binary: string,
  opts?: Options,
) => Promise<Provider<ProviderConfig>> {
  return async (binary: string, opts: Options = {}) => {
    const {subprocess, rpc} = await newRPC(binary, opts)
    const schema = await rpc.getSchema({})
    return new Provider<ProviderConfig>({
      subprocess,
      rpc,
      schema,
    })
  }
}

export const createProvider = createProviderFactory()

export function codegen(provider: Provider): string {
  const providerConfig = asCode(
    T.object({
      providerSchema: provider.providerSchema,
      dataSourceSchemas: T.object(provider.dataSourceSchemas),
      resourceSchemas: T.object(provider.resourceSchemas),
      dataSourceStateSchemas: T.object(provider.dataSourceStateSchemas),
      resourceStateSchemas: T.object(provider.resourceStateSchemas),
    }),
  )

  return `import {Provider} from '@ts-terraform/provider'

interface ProviderConfig extends ProviderConfigType ${providerConfig}

export const createProvider = createProviderFactory<ProviderConfig>()
`
}