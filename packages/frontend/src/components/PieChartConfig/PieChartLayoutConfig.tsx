import {
    Field,
    fieldId,
    isField,
    Metric,
    TableCalculation,
} from '@lightdash/common';
import {
    Box,
    Button,
    Group,
    Select,
    SelectItemProps,
    Stack,
    Switch,
    Text,
    Tooltip,
} from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import React, { forwardRef } from 'react';
import FieldIcon from '../common/Filters/FieldIcon';
import FieldLabel, { fieldLabelText } from '../common/Filters/FieldLabel';
import MantineIcon from '../common/MantineIcon';
import { useVisualizationContext } from '../LightdashVisualization/VisualizationProvider';

interface ItemProps extends SelectItemProps {
    icon: React.ReactNode;
    item: Field | Metric | TableCalculation;
    disabled: boolean;
}

const SelectItem = forwardRef<HTMLDivElement, ItemProps>(
    ({ icon, item, disabled, ...rest }: ItemProps, ref) => (
        <div ref={ref} {...rest}>
            <Group spacing="xs">
                <FieldIcon item={item} />

                <Text color={disabled ? 'dimmed' : undefined}>
                    <FieldLabel item={item} />
                </Text>
            </Group>
        </div>
    ),
);

const PieChartLayoutConfig: React.FC = () => {
    const {
        dimensions,
        allNumericMetrics,
        pieChartConfig: {
            metricId,
            metricChange,

            groupFieldIds,
            groupAdd,
            groupChange,
            groupRemove,

            selectedMetric,

            isDonut,
            toggleDonut,
        },
    } = useVisualizationContext();

    return (
        <Stack>
            <Stack spacing="xs">
                {groupFieldIds.map((dimensionId, index) => {
                    const dimension = dimensions.find(
                        (d) => fieldId(d) === dimensionId,
                    );

                    return (
                        <Select
                            disabled={dimensions.length === 0}
                            key={index}
                            clearable={index !== 0}
                            label={index === 0 ? 'Group' : undefined}
                            placeholder="Select dimension"
                            icon={dimension && <FieldIcon item={dimension} />}
                            value={dimensionId}
                            data={dimensions.map((d) => ({
                                item: d,
                                label: fieldLabelText(d),
                                value: fieldId(d),
                                disabled: groupFieldIds.includes(fieldId(d)),
                            }))}
                            itemComponent={SelectItem}
                            onChange={(newValue) =>
                                newValue === null
                                    ? groupRemove(dimensionId)
                                    : groupChange(dimensionId, newValue)
                            }
                        />
                    );
                })}

                <Tooltip
                    disabled={
                        !(
                            dimensions.length === 0 ||
                            groupFieldIds.length === dimensions.length
                        )
                    }
                    label={
                        dimensions.length === 0
                            ? 'You must select at least one dimension to create a pie chart'
                            : dimensions.length === groupFieldIds.length
                            ? 'To add more groups you need to add more dimensions to your query'
                            : undefined
                    }
                >
                    <Box w="fit-content">
                        <Button
                            w="fit-content"
                            size="xs"
                            leftIcon={<MantineIcon icon={IconPlus} />}
                            variant="outline"
                            onClick={groupAdd}
                            disabled={
                                dimensions.length === 0 ||
                                groupFieldIds.length === dimensions.length
                            }
                        >
                            Add Group
                        </Button>
                    </Box>
                </Tooltip>
            </Stack>

            <Tooltip
                disabled={allNumericMetrics.length > 0}
                label="You must select at least one numeric metric to create a pie chart"
            >
                <Box>
                    <Select
                        disabled={allNumericMetrics.length === 0}
                        label="Metric"
                        placeholder="Select metric"
                        value={metricId}
                        icon={
                            selectedMetric && (
                                <FieldIcon item={selectedMetric} />
                            )
                        }
                        itemComponent={SelectItem}
                        data={allNumericMetrics.map((m) => {
                            const id = isField(m) ? fieldId(m) : m.name;

                            return {
                                item: m,
                                value: id,
                                label: fieldLabelText(m),
                                disabled: metricId === id,
                            };
                        })}
                        onChange={(newValue) => {
                            metricChange(newValue);
                        }}
                    />
                </Box>
            </Tooltip>

            <Switch label="Donut" checked={isDonut} onChange={toggleDonut} />
        </Stack>
    );
};

export default PieChartLayoutConfig;
