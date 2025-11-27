<script lang="ts">
	import { stateUi } from 'state-shared';
	import { BLACK } from 'constants-shared/colors';
	import { MainContainer } from 'components-layout';
	import { Container, Rectangle, anchorToPivot } from 'pixi-svelte';

	import { getContext } from '../context';
	import type { LayoutUiProps } from '../types';

	type Props = {
		gameName: LayoutUiProps['gameName'];
		logo: LayoutUiProps['logo'];
		amountWin: LayoutUiProps['amountWin'];
		amountBet: LayoutUiProps['amountBet'];
		buttonMenu: LayoutUiProps['buttonMenu'];
		buttonTurbo: LayoutUiProps['buttonTurbo'];
		buttonPayTable: LayoutUiProps['buttonPayTable'];
		buttonGameRules: LayoutUiProps['buttonGameRules'];
		buttonSettings: LayoutUiProps['buttonSettings'];
		buttonSoundSwitch: LayoutUiProps['buttonSoundSwitch'];
		buttonMenuClose: LayoutUiProps['buttonMenuClose'];
	};

	const props: Props = $props();
	const context = getContext();
</script>

<Container x={20}>
	{@render props.gameName()}
</Container>

<Container x={context.stateLayoutDerived.canvasSizes().width - 20}>
	{@render props.logo()}
</Container>

<MainContainer standard alignVertical="bottom">
	<Container
		x={context.stateLayoutDerived.mainLayoutStandard().width * 0.5}
		y={context.stateLayoutDerived.mainLayoutStandard().height - 270}
		scale={0.8}
	>
		{@render props.amountWin({ stacked: true })}
	</Container>

	<Container
		x={context.stateLayoutDerived.mainLayoutStandard().width * 0.5}
		y={context.stateLayoutDerived.mainLayoutStandard().height - 150}
		scale={0.8}
	>
		{@render props.amountBet({ stacked: true })}
	</Container>

	<Container
		x={context.stateLayoutDerived.mainLayoutStandard().width * 0.5 - 350}
		y={context.stateLayoutDerived.mainLayoutStandard().height - 270 - 15}
		scale={0.7}
	>
		{@render props.buttonMenu({})}
	</Container>

	<Container
		x={context.stateLayoutDerived.mainLayoutStandard().width * 0.5 - 350}
		y={context.stateLayoutDerived.mainLayoutStandard().height - 150 - 15}
		scale={0.7}
	>
		{@render props.buttonTurbo({})}
	</Container>
</MainContainer>

{#if stateUi.menuOpen}
	<Rectangle
		eventMode="static"
		cursor="pointer"
		alpha={0.5}
		anchor={0.5}
		backgroundColor={BLACK}
		width={context.stateLayoutDerived.canvasSizes().width}
		height={context.stateLayoutDerived.canvasSizes().height}
		x={context.stateLayoutDerived.canvasSizes().width * 0.5}
		y={context.stateLayoutDerived.canvasSizes().height * 0.5}
		onpointerup={() => (stateUi.menuOpen = false)}
	/>

	<MainContainer standard alignVertical="bottom">
		<Container
			x={298}
			y={context.stateLayoutDerived.mainLayoutStandard().height - 0 - 10}
		>
			<Container scale={0.8} y={0 * 0.5 - 150 - 170 * 3}>
				{@render props.buttonPayTable({ anchor: 0.5 })}
			</Container>

			<Container scale={0.8} y={0 * 0.5 - 150 - 170 * 2}>
				{@render props.buttonGameRules({ anchor: 0.5 })}
			</Container>

			<Container scale={0.8} y={0 * 0.5 - 150 - 170 * 1}>
				{@render props.buttonSettings({ anchor: 0.5 })}
			</Container>

			<Container scale={0.8} y={0 * 0.5 - 150}>
				{@render props.buttonSoundSwitch({ anchor: 0.5 })}
			</Container>

			<Container scale={0.8} y={0 * 0.5}>
				{@render props.buttonMenuClose({ anchor: 0.5 })}
			</Container>
		</Container>
	</MainContainer>
{/if}
