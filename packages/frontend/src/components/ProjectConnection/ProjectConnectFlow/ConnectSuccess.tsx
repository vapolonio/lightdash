import { Colors } from '@blueprintjs/core';
import { FC } from 'react';
import LinkButton from '../../common/LinkButton';
import { ProjectCreationCard } from '../../common/Settings/SettingsCard';
import InviteExpertFooter from './InviteExpertFooter';
import { StyledSuccessIcon, Title, Wrapper } from './ProjectConnectFlow.styles';

interface ConnectSuccessProps {
    projectUuid: string;
}

const ConnectSuccess: FC<ConnectSuccessProps> = ({ projectUuid }) => {
    return (
        <Wrapper>
            <ProjectCreationCard>
                <Title>Your project's been created! 🎉</Title>

                <StyledSuccessIcon
                    icon="tick-circle"
                    color={Colors.GREEN4}
                    size={64}
                />

                <LinkButton
                    large
                    intent="primary"
                    href={`/projects/${projectUuid}/home`}
                >
                    Let's do some data!
                </LinkButton>
            </ProjectCreationCard>

            <InviteExpertFooter />
        </Wrapper>
    );
};

export default ConnectSuccess;
