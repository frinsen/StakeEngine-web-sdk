import type { Meta, StoryObj } from '@storybook/svelte';
import CrashGame from '../components/CrashGame.svelte';

const meta: Meta<typeof CrashGame> = {
	title: 'Crash Game/Play',
	component: CrashGame,
	args: {},
};

export default meta;

type Story = StoryObj<typeof CrashGame>;

export const Play: Story = {
	render: (args) => ({ Component: CrashGame, props: args }),
};
