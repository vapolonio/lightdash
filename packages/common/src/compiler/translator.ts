import {
    buildModelGraph,
    convertMetric,
    DbtMetric,
    DbtModelColumn,
    DbtModelNode,
    LineageGraph,
    SupportedDbtAdapter,
} from '../types/dbt';
import {
    MissingCatalogEntryError,
    NonCompiledModelError,
    ParseError,
} from '../types/errors';
import { Explore, ExploreError, Table } from '../types/explore';
import {
    defaultSql,
    Dimension,
    DimensionType,
    FieldType,
    friendlyName,
    Metric,
    MetricType,
    parseMetricType,
    Source,
} from '../types/field';
import { parseFilters } from '../types/filterGrammar';
import { TimeFrames } from '../types/timeFrames';
import assertUnreachable from '../utils/assertUnreachable';
import {
    getDefaultTimeFrames,
    timeFrameConfigs,
    validateTimeFrames,
} from '../utils/timeFrames';
import { compileExplore } from './exploreCompiler';

const convertTimezone = (
    timestampSql: string,
    default_source_tz: string,
    target_tz: string,
    adapterType: SupportedDbtAdapter,
) => {
    // todo: implement default_source_tz
    // todo: implement target_tz
    // todo: implement conversion for all adapters
    switch (adapterType) {
        case SupportedDbtAdapter.BIGQUERY:
            // TIMESTAMPS: stored as utc. returns utc. convert from utc to target_tz
            //   DATETIME: no tz. assume default_source_tz. covert from default_source_tz to target_tz
            return timestampSql;
        case SupportedDbtAdapter.SNOWFLAKE:
            // TIMESTAMP_NTZ: no tz. assume default_source_tz. convert from default_source_tz to target_tz
            // TIMESTAMP_LTZ: stored in utc. returns in session tz. convert from session tz to target_tz
            // TIMESTAMP_TZ: stored with tz. returns with tz. convert from value tz to target_tz
            return `TO_TIMESTAMP_NTZ(CONVERT_TIMEZONE('UTC', ${timestampSql}))`;
        case SupportedDbtAdapter.REDSHIFT:
            // TIMESTAMP WITH TIME ZONE: stored in utc. returns utc. convert from utc to target_tz
            // TIMESTAMP WITHOUT TIME ZONE: no tz. assume utc. convert from utc to target_tz
            return timestampSql;
        case SupportedDbtAdapter.POSTGRES:
            // TIMESTAMP WITH TIME ZONE: stored as utc. returns in session tz. convert from session tz to target tz
            // TIMESTAMP WITHOUT TIME ZONE: no tz. assume default_source_tz. convert from default_source_tz to target_tz
            return timestampSql;
        case SupportedDbtAdapter.DATABRICKS:
            return timestampSql;
        case SupportedDbtAdapter.TRINO:
            return timestampSql;
        default:
            return assertUnreachable(
                adapterType,
                new ParseError(`Cannot recognise warehouse ${adapterType}`),
            );
    }
};

const convertDimension = (
    targetWarehouse: SupportedDbtAdapter,
    model: Pick<DbtModelNode, 'name' | 'relation_name'>,
    tableLabel: string,
    column: DbtModelColumn,
    source?: Source,
    timeInterval?: TimeFrames,
): Dimension => {
    let type =
        column.meta.dimension?.type || column.data_type || DimensionType.STRING;
    if (!Object.values(DimensionType).includes(type)) {
        throw new MissingCatalogEntryError(
            `Could not recognise type "${type}" for dimension "${
                column.name
            }" in dbt model "${model.name}". Valid types are: ${Object.values(
                DimensionType,
            ).join(', ')}`,
            {},
        );
    }
    let group: string | undefined;
    let name = column.meta.dimension?.name || column.name;
    let sql = column.meta.dimension?.sql || defaultSql(column.name);
    let label = column.meta.dimension?.label || friendlyName(name);
    if (type === DimensionType.TIMESTAMP) {
        sql = convertTimezone(sql, 'UTC', 'UTC', targetWarehouse);
    }
    if (timeInterval) {
        sql = timeFrameConfigs[timeInterval].getSql(
            targetWarehouse,
            timeInterval,
            sql,
            type,
        );
        name = `${column.name}_${timeInterval.toLowerCase()}`;
        label = `${label} ${timeFrameConfigs[timeInterval]
            .getLabel()
            .toLowerCase()}`;
        group = column.name;
        type = timeFrameConfigs[timeInterval].getDimensionType(type);
    }
    return {
        fieldType: FieldType.DIMENSION,
        name,
        label,
        sql,
        table: model.name,
        tableLabel,
        type,
        description: column.meta.dimension?.description || column.description,
        source,
        group,
        timeInterval,
        hidden: !!column.meta.dimension?.hidden,
        format: column.meta.dimension?.format,
        round: column.meta.dimension?.round,
        compact: column.meta.dimension?.compact,
        groupLabel: column.meta.dimension?.group_label,
        ...(column.meta.dimension?.urls
            ? { urls: column.meta.dimension.urls }
            : {}),
    };
};

const generateTableLineage = (
    model: DbtModelNode,
    depGraph: ReturnType<typeof buildModelGraph>,
): LineageGraph => {
    const modelFamilyIds = [
        ...depGraph.dependantsOf(model.unique_id),
        ...depGraph.dependenciesOf(model.unique_id),
        model.unique_id,
    ];
    return modelFamilyIds.reduce<LineageGraph>(
        (prev, nodeId) => ({
            ...prev,
            [depGraph.getNodeData(nodeId).name]: depGraph
                .directDependenciesOf(nodeId)
                .map((d) => depGraph.getNodeData(d)),
        }),
        {},
    );
};

const convertDbtMetricToLightdashMetric = (
    metric: DbtMetric,
    tableName: string,
    tableLabel: string,
): Metric => {
    let sql: string;
    let type: MetricType;
    if (metric.calculation_method === 'expression') {
        type = MetricType.NUMBER;
        const referencedMetrics = (metric.metrics || []).map((m) => m[0]);
        if (!metric.expression) {
            throw new ParseError(
                `dbt expression metric "${metric.name}" must have the sql field set`,
            );
        }
        sql = metric.expression;

        referencedMetrics.forEach((ref) => {
            const re = new RegExp(ref, 'g');
            // eslint-disable-next-line no-useless-escape
            sql = sql.replace(re, `\$\{${ref}\}`);
        });
    } else {
        try {
            type = parseMetricType(metric.calculation_method);
        } catch (e) {
            throw new ParseError(
                `Cannot parse metric '${metric.unique_id}: type ${metric.calculation_method} is not a valid Lightdash metric type`,
            );
        }
        sql = defaultSql(metric.name);
        if (metric.expression) {
            const isSingleColumnName = /^[a-zA-Z0-9_]+$/g.test(
                metric.expression,
            );
            if (isSingleColumnName) {
                sql = defaultSql(metric.expression);
            } else {
                sql = metric.expression;
            }
        }
    }
    if (metric.filters && metric.filters.length > 0) {
        const filterSql = metric.filters
            .map(
                (filter) =>
                    // eslint-disable-next-line no-useless-escape
                    `(\$\{TABLE\}.${filter.field} ${filter.operator} ${filter.value})`,
            )
            .join(' AND ');
        sql = `CASE WHEN ${filterSql} THEN ${sql} ELSE NULL END`;
    }

    return {
        fieldType: FieldType.METRIC,
        type,
        isAutoGenerated: false,
        name: metric.name,
        label: metric.label || friendlyName(metric.name),
        table: tableName,
        tableLabel,
        sql,
        description: metric.description,
        source: undefined,
        hidden: !!metric.meta?.hidden,
        round: metric.meta?.round,
        compact: metric.meta?.compact,
        format: metric.meta?.format,
        groupLabel: metric.meta?.group_label,
        showUnderlyingValues: metric.meta?.show_underlying_values,
        filters: parseFilters(metric.meta?.filters),
        ...(metric.meta?.urls ? { urls: metric.meta.urls } : {}),
    };
};

export const convertTable = (
    adapterType: SupportedDbtAdapter,
    model: DbtModelNode,
    dbtMetrics: DbtMetric[],
): Omit<Table, 'lineageGraph'> => {
    if (!model.compiled) {
        throw new NonCompiledModelError(`Model has not been compiled by dbt`);
    }
    const meta = model.config?.meta || model.meta; // Config block takes priority, then meta block
    const tableLabel = meta.label || friendlyName(model.name);
    const [dimensions, metrics]: [
        Record<string, Dimension>,
        Record<string, Metric>,
    ] = Object.values(model.columns).reduce(
        ([prevDimensions, prevMetrics], column) => {
            const dimension = convertDimension(
                adapterType,
                model,
                tableLabel,
                column,
            );

            let extraDimensions = {};

            if (
                [DimensionType.DATE, DimensionType.TIMESTAMP].includes(
                    dimension.type,
                ) &&
                ((column.meta.dimension?.time_intervals &&
                    column.meta.dimension.time_intervals !== 'OFF') ||
                    !column.meta.dimension?.time_intervals)
            ) {
                let intervals: TimeFrames[] = [];
                if (
                    column.meta.dimension?.time_intervals &&
                    Array.isArray(column.meta.dimension.time_intervals)
                ) {
                    intervals = validateTimeFrames(
                        column.meta.dimension.time_intervals,
                    );
                } else {
                    intervals = getDefaultTimeFrames(dimension.type);
                }

                extraDimensions = intervals.reduce(
                    (acc, interval) => ({
                        ...acc,
                        [`${column.name}_${interval}`]: convertDimension(
                            adapterType,
                            model,
                            tableLabel,
                            column,
                            undefined,
                            interval,
                        ),
                    }),
                    {},
                );
            }

            const columnMetrics = Object.fromEntries(
                Object.entries(column.meta.metrics || {}).map(
                    ([name, metric]) => [
                        name,
                        convertMetric({
                            modelName: model.name,
                            dimensionName: dimension.name,
                            dimensionSql: dimension.sql,
                            name,
                            metric,
                            tableLabel,
                        }),
                    ],
                ),
            );

            return [
                {
                    ...prevDimensions,
                    [column.name]: dimension,
                    ...extraDimensions,
                },
                { ...prevMetrics, ...columnMetrics },
            ];
        },
        [{}, {}],
    );

    const convertedDbtMetrics = Object.fromEntries(
        dbtMetrics.map((metric) => [
            metric.name,
            convertDbtMetricToLightdashMetric(metric, model.name, tableLabel),
        ]),
    );
    const allMetrics = { ...convertedDbtMetrics, ...metrics }; // Model-level metric names take priority

    const duplicatedNames = Object.keys(allMetrics).filter((metric) =>
        Object.keys(dimensions).includes(metric),
    );
    if (duplicatedNames.length > 0) {
        const message =
            duplicatedNames.length > 1
                ? 'Found multiple metrics and a dimensions with the same name:'
                : 'Found a metric and a dimension with the same name:';
        throw new ParseError(`${message} ${duplicatedNames}`);
    }

    if (!model.relation_name) {
        throw new Error('Model has no table relation');
    }
    return {
        name: model.name,
        label: tableLabel,
        database: model.database,
        schema: model.schema,
        sqlTable: model.relation_name,
        description: model.description || `${model.name} table`,
        dimensions,
        metrics: allMetrics,
    };
};

const translateDbtModelsToTableLineage = (
    models: DbtModelNode[],
): Record<string, Pick<Table, 'lineageGraph'>> => {
    const graph = buildModelGraph(models);
    return models.reduce<Record<string, Pick<Table, 'lineageGraph'>>>(
        (previousValue, currentValue) => ({
            ...previousValue,
            [currentValue.name]: {
                lineageGraph: generateTableLineage(currentValue, graph),
            },
        }),
        {},
    );
};

const modelCanUseMetric = (
    metricName: string,
    modelName: string,
    metrics: DbtMetric[],
): boolean => {
    const metric = metrics.find((m) => m.name === metricName);
    if (!metric) {
        return false;
    }
    const modelRef = metric.refs?.[0]?.[0];
    if (modelRef === modelName) {
        return true;
    }
    if (metric.calculation_method === 'expression') {
        const referencedMetrics = (metric.metrics || []).map((m) => m[0]);
        return referencedMetrics.every((m) =>
            modelCanUseMetric(m, modelName, metrics),
        );
    }
    return false;
};

export const convertExplores = async (
    models: DbtModelNode[],
    loadSources: boolean,
    adapterType: SupportedDbtAdapter,
    metrics: DbtMetric[],
): Promise<(Explore | ExploreError)[]> => {
    const tableLineage = translateDbtModelsToTableLineage(models);
    const [tables, exploreErrors] = models.reduce(
        ([accTables, accErrors], model) => {
            const meta = model.config?.meta || model.meta; // Config block takes priority, then meta block
            // If there are any errors compiling the table return an ExploreError
            try {
                // base dimensions and metrics
                const tableMetrics = metrics.filter((metric) =>
                    modelCanUseMetric(metric.name, model.name, metrics),
                );
                const table = convertTable(adapterType, model, tableMetrics);

                // add sources
                if (loadSources && model.patch_path !== null) {
                    throw new Error('Not Implemented');
                }

                // add lineage
                const tableWithLineage: Table = {
                    ...table,
                    ...tableLineage[model.name],
                };

                return [[...accTables, tableWithLineage], accErrors];
            } catch (e) {
                const exploreError: ExploreError = {
                    name: model.name,
                    label: meta.label || friendlyName(model.name),
                    tags: model.tags,
                    errors: [
                        {
                            type: e.name,
                            message:
                                e.message ||
                                `Could not convert dbt model: "${model.name}" in to a Lightdash explore`,
                        },
                    ],
                };
                return [accTables, [...accErrors, exploreError]];
            }
        },
        [[], []] as [Table[], ExploreError[]],
    );
    const tableLookup: Record<string, Table> = tables.reduce(
        (prev, table) => ({ ...prev, [table.name]: table }),
        {},
    );
    const validModels = models.filter(
        (model) => tableLookup[model.name] !== undefined,
    );
    const explores: (Explore | ExploreError)[] = validModels.map((model) => {
        const meta = model.config?.meta || model.meta; // Config block takes priority, then meta block
        try {
            return compileExplore({
                name: model.name,
                label: meta.label || friendlyName(model.name),
                tags: model.tags || [],
                baseTable: model.name,
                joinedTables: (meta?.joins || []).map((join) => ({
                    table: join.join,
                    sqlOn: join.sql_on,
                })),
                tables: tableLookup,
                targetDatabase: adapterType,
            });
        } catch (e) {
            return {
                name: model.name,
                label: meta.label || friendlyName(model.name),
                errors: [{ type: e.name, message: e.message }],
            };
        }
    });

    return [...explores, ...exploreErrors];
};

export const attachTypesToModels = (
    models: DbtModelNode[],
    warehouseCatalog: {
        [database: string]: {
            [schema: string]: {
                [table: string]: { [column: string]: DimensionType };
            };
        };
    },
    throwOnMissingCatalogEntry: boolean = true,
    caseSensitiveMatching: boolean = true,
): DbtModelNode[] => {
    // Check that all models appear in the warehouse
    models.forEach(({ database, schema, name }) => {
        const databaseMatch = Object.keys(warehouseCatalog).find((db) =>
            caseSensitiveMatching
                ? db === database
                : db.toLowerCase() === database.toLowerCase(),
        );
        const schemaMatch =
            databaseMatch &&
            Object.keys(warehouseCatalog[databaseMatch]).find((s) =>
                caseSensitiveMatching
                    ? s === schema
                    : s.toLowerCase() === schema.toLowerCase(),
            );
        const tableMatch =
            databaseMatch &&
            schemaMatch &&
            Object.keys(warehouseCatalog[databaseMatch][schemaMatch]).find(
                (t) =>
                    caseSensitiveMatching
                        ? t === name
                        : t.toLowerCase() === name.toLowerCase(),
            );
        if (!tableMatch && throwOnMissingCatalogEntry) {
            throw new MissingCatalogEntryError(
                `Model "${name}" was expected in your target warehouse at "${database}.${schema}.${name}". Does the table exist in your target data warehouse?`,
                {},
            );
        }
    });

    const getType = (
        { database, schema, name }: DbtModelNode,
        columnName: string,
    ): DimensionType | undefined => {
        const databaseMatch = Object.keys(warehouseCatalog).find((db) =>
            caseSensitiveMatching
                ? db === database
                : db.toLowerCase() === database.toLowerCase(),
        );
        const schemaMatch =
            databaseMatch &&
            Object.keys(warehouseCatalog[databaseMatch]).find((s) =>
                caseSensitiveMatching
                    ? s === schema
                    : s.toLowerCase() === schema.toLowerCase(),
            );
        const tableMatch =
            databaseMatch &&
            schemaMatch &&
            Object.keys(warehouseCatalog[databaseMatch][schemaMatch]).find(
                (t) =>
                    caseSensitiveMatching
                        ? t === name
                        : t.toLowerCase() === name.toLowerCase(),
            );
        const columnMatch =
            databaseMatch &&
            schemaMatch &&
            tableMatch &&
            Object.keys(
                warehouseCatalog[databaseMatch][schemaMatch][tableMatch],
            ).find((c) =>
                caseSensitiveMatching
                    ? c === columnName
                    : c.toLowerCase() === columnName.toLowerCase(),
            );
        if (databaseMatch && schemaMatch && tableMatch && columnMatch) {
            return warehouseCatalog[databaseMatch][schemaMatch][tableMatch][
                columnMatch
            ];
        }
        if (throwOnMissingCatalogEntry) {
            throw new MissingCatalogEntryError(
                `Column "${columnName}" from model "${name}" does not exist.\n "${name}.${columnName}" was not found in your target warehouse at ${database}.${schema}.${name}. Try rerunning dbt to update your warehouse.`,
                {},
            );
        }
        return undefined;
    };

    // Update the dbt models with type info
    return models.map((model) => ({
        ...model,
        columns: Object.fromEntries(
            Object.entries(model.columns).map(([column_name, column]) => [
                column_name,
                { ...column, data_type: getType(model, column_name) },
            ]),
        ),
    }));
};

export const getSchemaStructureFromDbtModels = (
    dbtModels: DbtModelNode[],
): { database: string; schema: string; table: string }[] =>
    dbtModels.map(({ database, schema, name }) => ({
        database,
        schema,
        table: name,
    }));
