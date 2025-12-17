<script lang="ts">
	import { onMount } from 'svelte';

	// Configuration
	const API_BASE_URL = 'http://localhost:3000';

	// Type for game history
	interface GameRound {
		roundId: string;
		betAmount: number;
		outcome: 'Cashed Out' | 'Crashed';
		cashoutAmount: number;
		autoCashoutTriggered: boolean;
		autoplayStatus: string;
		multiplier: number;
	}

	let balance = 1000;
	let betAmount = 10;
	let autoCashoutMultiplier = 2.0;
	let autoCashoutEnabled = false;
	let autoplayRounds = 10;
	let autoplayRoundsPlayed = 0;
	let crashPoint = 1.0;
	let gameStarted = false;
	let gameEnded = false;
	let currentMultiplier = 1.0;
	let playerCashedOut = false;
	let gameMessage = 'Place your bet';
	let targetCashoutMultiplier: number | null = null; // Server-determined cashout point
	let manualCashoutTriggered = false; // Track if user manually cashed out
	let autoCashoutTriggered = false; // Track if auto-cashout has already fired
	let gameInterval: ReturnType<typeof setInterval> | null = null; // Store interval reference
	let cashoutDelay = 0; // Milliseconds to process cashout
	let currentRoundId: string | null = null; // Track current round for backend
	let serverSeedHash: string | null = null; // Committed server seed hash for verification
	let clientSeed: string | null = null; // Client seed used for calculation
	let nonce: number = 0; // Nonce used for calculation
	let gameHistory: GameRound[] = []; // Track game history

	// Verification state
	let isVerifying = false;
	let verificationMessage: string = '';
	let verificationCrashPoint: number | null = null;
	let revealedServerSeed: string | null = null;
	let hashVerified: boolean | null = null;
	let computedHash: string | null = null;
	let isVerifyModalOpen = false; // Modal state for verification details

	/**
	 * Compute SHA256 hash client-side using Web Crypto API
	 */
	async function sha256(data: string): Promise<string> {
		try {
			const encoder = new TextEncoder();
			const buffer = encoder.encode(data);
			const hashBuffer = await (globalThis.crypto || (window as any).crypto).subtle.digest('SHA-256', buffer);
			const hashArray = Array.from(new Uint8Array(hashBuffer));
			return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
		} catch (e) {
			console.error('Hash computation failed:', e);
			throw new Error('Failed to compute hash');
		}
	}
	
	// Autoplay statistics
	let autoplayStats = {
		wins: 0,
		losses: 0,
		totalBet: 0,
		totalWon: 0
	};
	let showAutoplaySummary = false;

	const animationDuration = 3000; // 3 seconds for animation

	// Simulate backend function that determines game outcome
	async function getGameOutcome(bet: number, autoCashout: boolean, autoCashoutAt: number) {
		try {
			// Call real backend to get crash point
			const response = await fetch(`${API_BASE_URL}/crash/calculate`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					roundId: currentRoundId,
					clientSeed,
					nonce
				})
			});

			if (!response.ok) {
				let errMsg = 'Server error';
				try {
					const errBody = await response.json();
					errMsg = errBody?.error || errMsg;
				} catch {}
				throw new Error(errMsg);
			}

			const data = await response.json();
			const crashPt = data.crashPoint;

			// Server-side logic: Determine if game auto-cashes out BEFORE animation starts
			if (autoCashout && crashPt >= autoCashoutAt) {
				// Auto-cashout triggered: game will end at exactly autoCashoutAt
				return {
					willAutoCashout: true,
					finalMultiplier: autoCashoutAt,
					crashPoint: crashPt,
				};
			}

			// No auto-cashout: game runs to crash point
			return {
				willAutoCashout: false,
				finalMultiplier: crashPt,
				crashPoint: crashPt,
			};
		} catch (error) {
			console.error('Error fetching crash point:', error);
			throw error;
		}
	}

	async function verifyFairness() {
		if (!currentRoundId || !serverSeedHash || !clientSeed) {
			verificationMessage = 'Missing data to verify round';
			return;
		}
		isVerifying = true;
		verificationMessage = 'Verifying...';
		verificationCrashPoint = null;
		revealedServerSeed = null;
		hashVerified = null;
		computedHash = null;
		try {
			// Reveal server seed
			const revealResp = await fetch(`${API_BASE_URL}/crash/reveal/${currentRoundId}`);
			if (!revealResp.ok) {
				const err = await revealResp.json().catch(() => ({}));
				throw new Error(err?.error || 'Failed to reveal server seed');
			}
			const revealData = await revealResp.json();
			revealedServerSeed = revealData.serverSeed;

			// Compute hash client-side and verify
			computedHash = await sha256(revealedServerSeed);
			hashVerified = computedHash === serverSeedHash;

			// Verify round
			const verifyResp = await fetch(`${API_BASE_URL}/crash/verify`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					roundId: currentRoundId,
					serverSeed: revealedServerSeed,
					clientSeed,
					nonce
				})
			});
			if (!verifyResp.ok) {
				const err = await verifyResp.json().catch(() => ({}));
				throw new Error(err?.error || 'Verification failed');
			}
			const verifyData = await verifyResp.json();
			verificationCrashPoint = verifyData.crashPoint;
			const matches = Math.abs((verificationCrashPoint ?? 0) - crashPoint) < 0.005;
			verificationMessage = matches
				? `Verified ✓ Crash point ${verificationCrashPoint!.toFixed(2)}x`
				: `Warning: mismatch (${verificationCrashPoint!.toFixed(2)}x vs ${crashPoint.toFixed(2)}x)`;
		} catch (e) {
			verificationMessage = typeof (e as any)?.message === 'string' ? (e as any).message : 'Verification error';
		} finally {
			isVerifying = false;
		}
	}

	async function startGame() {
		if (betAmount <= 0 || betAmount > balance) {
			gameMessage = 'Invalid bet amount';
			return;
		}

		// Ensure auto-cashout is greater than 1
		if (autoCashoutEnabled && autoCashoutMultiplier <= 1) {
			gameMessage = 'Auto-cashout must be greater than 1.00x';
			balance += betAmount; // Refund the bet since we didn't start
			return;
		}

		// Clear any existing interval from previous game
		if (gameInterval) {
			clearInterval(gameInterval);
			gameInterval = null;
		}

		// Initialize round on backend
		try {
			const initResponse = await fetch(`${API_BASE_URL}/crash/init`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({})
			});
			if (!initResponse.ok) {
				const errBody = await initResponse.json().catch(() => ({}));
				throw new Error(errBody?.error || 'Failed to init round');
			}
			const initData = await initResponse.json();
			currentRoundId = initData.roundId;
			serverSeedHash = initData.serverSeedHash || null;
		} catch (error) {
			console.error('Error initializing round:', error);
			gameMessage = 'Error connecting to server';
			return;
		}

		// Prepare client seed/nonce for this round
		clientSeed = Math.random().toString(36);
		nonce = 0;

		// Generate new crash point for this game
		crashPoint = Math.random() * 100 + 0.1;

		gameStarted = true;
		gameEnded = false;
		playerCashedOut = false;
		manualCashoutTriggered = false;
		autoCashoutTriggered = false;
		currentMultiplier = 1.0;
		gameMessage = 'Game started...';
		balance -= betAmount;

		// Capture settings
		const bet = betAmount;
		const shouldAutoCashout = autoCashoutEnabled;
		const autoCashoutAt = Math.max(autoCashoutMultiplier, 1.01); // Force minimum 1.01

		// === BACKEND CALL - Get real crash point ===
		try {
			const gameOutcome = await getGameOutcome(bet, shouldAutoCashout, autoCashoutAt);
			targetCashoutMultiplier = gameOutcome.finalMultiplier;
			crashPoint = gameOutcome.crashPoint; // Update with real backend crash point
		} catch (err) {
			gameMessage = typeof (err as any)?.message === 'string' ? (err as any).message : 'Server error during calculation';
			// Refund bet and abort
			balance += bet;
			gameStarted = false;
			gameEnded = false;
			return;
		}
		// === END BACKEND CALL ===

		// Now animate to the pre-determined outcome
		const startTime = Date.now();
		gameInterval = setInterval(() => {
			// Stop animation if manual cashout was triggered
			if (manualCashoutTriggered) {
				clearInterval(gameInterval);
				gameInterval = null;
				return;
			}

			const elapsed = Date.now() - startTime;
			
			// Exponential acceleration: multiplier grows faster over time (independent of outcome)
			// This creates natural "exponential growth" behavior where speed increases with multiplier
			const accelerationFactor = Math.exp(elapsed / 800); // Adjust divisor to control acceleration speed
			currentMultiplier = accelerationFactor;

			// Game ends when the multiplier reaches or exceeds the target (auto-cashout or crash point)
			// This makes timing unpredictable while keeping the outcome pre-determined
			if (currentMultiplier >= targetCashoutMultiplier!) {
				// Prevent the game loop from running multiple times
				if (autoCashoutTriggered) {
					return;
				}
				autoCashoutTriggered = true;
				
				currentMultiplier = targetCashoutMultiplier!;
				clearInterval(gameInterval);
				gameInterval = null;
				gameEnded = true;
				gameStarted = false;
				playerCashedOut = true;

				const winnings = bet * targetCashoutMultiplier!;
				const wasCashedOut = manualCashoutTriggered; // Capture the state BEFORE we continue

				if (!wasCashedOut) {
					// Only add winnings if this wasn't a manual cashout (manual cashout already added winnings)
					balance += winnings;
				}

				// Record game in history
				// Determine payout: use current multiplier for manual cashout, target multiplier for auto-cashout/crash
				const payoutAmount = wasCashedOut ? bet * currentMultiplier : (gameOutcome.willAutoCashout ? winnings : 0);
				recordGameRound(
					wasCashedOut,
					payoutAmount,
					gameOutcome.willAutoCashout,
					autoplayRoundsPlayed > 0 ? `${autoplayRoundsPlayed}/${autoplayRounds}` : 'No'
				);

				if (gameOutcome.willAutoCashout && !wasCashedOut) {
					gameMessage = `Auto cashed out at ${targetCashoutMultiplier!.toFixed(2)}x! Won ${winnings.toFixed(2)}!`;
					// Track autoplay stats
					if (autoplayRoundsPlayed > 0) {
						autoplayStats.wins++;
						autoplayStats.totalWon += winnings;
						autoplayStats.totalBet += bet;
					}
				} else if (wasCashedOut) {
					// Manual cashout already handled, don't override message
				} else {
					gameMessage = `Crashed at ${targetCashoutMultiplier!.toFixed(2)}x - Lost ${bet.toFixed(2)}`;
					// Track autoplay stats
					if (autoplayRoundsPlayed > 0) {
						autoplayStats.losses++;
						autoplayStats.totalBet += bet;
					}
				}

				// Reset verification state for this completed round
				isVerifying = false;
				verificationMessage = '';
				verificationCrashPoint = null;
				revealedServerSeed = null;
				hashVerified = null;
				computedHash = null;
				isVerifyModalOpen = false;

				// Handle autoplay - continue if no manual cashout happened
				if (autoplayRoundsPlayed > 0 && autoplayRoundsPlayed < autoplayRounds && !wasCashedOut) {
					autoplayRoundsPlayed++;
					setTimeout(() => {
						startGame();
					}, 500); // 500ms delay before next round
				} else if (autoplayRoundsPlayed >= autoplayRounds) {
					// Autoplay complete - show summary
					showAutoplaySummary = true;
					setTimeout(() => {
						showAutoplaySummary = false;
					}, 8000); // Show summary for 8 seconds
					autoplayRoundsPlayed = 0;
					gameMessage = `Autoplay complete!`;
				}
			}
		}, 16); // ~60fps
	}

	function startAutoplay() {
		if (!autoCashoutEnabled) {
			gameMessage = 'Auto-cashout must be enabled for autoplay';
			return;
		}
		if (autoplayRounds <= 0) {
			gameMessage = 'Rounds must be greater than 0';
			return;
		}
		// Reset autoplay statistics
		autoplayStats = {
			wins: 0,
			losses: 0,
			totalBet: 0,
			totalWon: 0
		};
		showAutoplaySummary = false;
		autoplayRoundsPlayed = 1; // Start at 1 for first round
		startGame();
	}

	function recordGameRound(wasCashedOut: boolean, cashoutAmount: number, autoCashoutTriggered: boolean, autoplayStatus: string) {
		if (!currentRoundId) return;
		
		// Determine outcome: cashed out if manual cashout OR auto-cashout triggered
		const isCashedOut = wasCashedOut || autoCashoutTriggered;
		
		const round: GameRound = {
			roundId: currentRoundId.slice(0, 8), // Short ID for display
			betAmount: betAmount,
			outcome: isCashedOut ? 'Cashed Out' : 'Crashed',
			cashoutAmount: cashoutAmount,
			autoCashoutTriggered: autoCashoutTriggered,
			autoplayStatus: autoplayStatus,
			multiplier: currentMultiplier
		};
		
		// Add to history (keep last 10 rounds)
		gameHistory = [round, ...gameHistory].slice(0, 10);
	}

	function cashOut() {
		// Prevent multiple rapid clicks
		if (!gameStarted || manualCashoutTriggered || playerCashedOut) return;
		
		const cashoutStartTime = Date.now();
		manualCashoutTriggered = true;
		playerCashedOut = true;
		gameStarted = false;
		gameEnded = true;
		const winnings = betAmount * currentMultiplier;
		balance += winnings;
		
		gameMessage = 'Processing cashout...';
		
		// Clear the interval immediately before any async operations
		if (gameInterval) {
			clearInterval(gameInterval);
			gameInterval = null;
		}
		
		// Simulate sending cashout request to backend and measuring real network latency
		setTimeout(async () => {
			try {
				// This would be a real API call in production to confirm cashout
				const response = await fetch(`${API_BASE_URL}/crash/reveal/${currentRoundId}`, {
					method: 'GET'
				});
				
				// Calculate real network delay
				cashoutDelay = Date.now() - cashoutStartTime;
				
				if (response.ok) {
					gameMessage = `Manually cashed out at ${currentMultiplier.toFixed(2)}x! Won ${winnings.toFixed(2)}! (${cashoutDelay}ms)`;
				} else {
					gameMessage = `Manually cashed out at ${currentMultiplier.toFixed(2)}x! Won ${winnings.toFixed(2)}! (${cashoutDelay}ms)`;
				}
			} catch (error) {
				console.error('Error processing cashout:', error);
				cashoutDelay = Date.now() - cashoutStartTime;
				gameMessage = `Manually cashed out at ${currentMultiplier.toFixed(2)}x! Won ${winnings.toFixed(2)}! (${cashoutDelay}ms)`;
			}
		}, 50); // Small delay to simulate backend processing
		
		// Stop autoplay if active
		if (autoplayRoundsPlayed > 0) {
			autoplayRoundsPlayed = 0;
		}
		
		// Record manual cashout in history
		recordGameRound(true, winnings, false, 'No');
	}

	onMount(() => {
		// Crash point will be set by the story
		crashPoint = Math.random() * 100 + 0.1; // Random between 0.1 and 100
	});
</script>

<div class="crash-game-container">
	<div class="game-header">
		<h1>Crash Game</h1>
		<div class="balance-info">
			<div class="balance">
				<span class="label">Balance:</span>
				<span class="value">${balance.toFixed(2)}</span>
			</div>
		</div>
	</div>

	<div class="game-layout">
		<div class="game-section">
			<div class="game-board">
				<div class="crash-display">
					{#if autoplayRoundsPlayed > 0}
						<div class="autoplay-status">
							Autoplay in progress: {autoplayRoundsPlayed} / {autoplayRounds} rounds
						</div>
					{/if}

					<div class="multiplier-text">
						{#if gameStarted || gameEnded}
							<span class={gameEnded ? 'crashed' : 'active'}>
								{currentMultiplier.toFixed(2)}x
							</span>
						{:else}
							<span class="waiting">Waiting...</span>
						{/if}
					</div>
					<div class="game-status">
						{gameMessage}
					</div>
					{#if gameEnded && crashPoint > 0}
						<div class="crash-point-info">
							<span class="label">True crash point:</span>
							<span class="value">{crashPoint.toFixed(2)}x</span>
						</div>
					{/if}

					{#if currentRoundId}
						<div class="crash-point-info">
							<span class="label">Round ID:</span>
							<button 
								class="round-id-button" 
								on:click={() => isVerifyModalOpen = true}
								title="Click to verify fairness"
							>
								{currentRoundId.slice(0, 8)}
							</button>
						</div>
					{/if}
				</div>
			</div>
		</div>

		<div class="betting-section">
			<div class="settings-row">
				<div class="input-group">
					<label for="bet">Bet Amount:</label>
					<input
						type="number"
						id="bet"
						bind:value={betAmount}
						disabled={gameStarted || autoplayRoundsPlayed > 0}
						min="0.1"
						step="0.1"
					/>
				</div>

				<div class="input-group">
					<label for="autocashout">
						<input
							type="checkbox"
							id="autocashout"
							bind:checked={autoCashoutEnabled}
							disabled={gameStarted || autoplayRoundsPlayed > 0}
						/>
						Auto Cashout at
					</label>
					<input
						type="number"
						bind:value={autoCashoutMultiplier}
						disabled={gameStarted || autoplayRoundsPlayed > 0 || !autoCashoutEnabled}
						min="1.01"
						step="0.1"
					/>
					<span>x</span>
				</div>
			</div>

			<div class="settings-row">
				<div class="input-group">
					<label for="autoplay-rounds">Autoplay Rounds:</label>
					<input
						type="number"
						id="autoplay-rounds"
						bind:value={autoplayRounds}
						disabled={gameStarted || autoplayRoundsPlayed > 0 || !autoCashoutEnabled}
						min="1"
						step="1"
						placeholder="Rounds"
					/>
				</div>
			</div>

			<div class="button-group">
					{#if gameStarted}
						<button class="cashout" on:click={cashOut}>
							Cash Out ({currentMultiplier.toFixed(2)}x = ${(betAmount * currentMultiplier).toFixed(2)})
						</button>
					{:else}
						<button 
							on:click={startGame} 
						disabled={balance <= 0 || autoplayRoundsPlayed > 0}
						title={autoplayRoundsPlayed > 0 ? 'Stop autoplay first' : balance <= 0 ? 'Insufficient balance' : 'Place bet'}
						>
							Place Bet
						</button>
					{/if}
					{#if autoplayRoundsPlayed === 0 && !gameStarted}
						<button 
							class="autoplay-btn" 
							on:click={startAutoplay} 
							disabled={balance <= 0 || !autoCashoutEnabled || autoplayRoundsPlayed > 0}
							title={!autoCashoutEnabled ? 'Enable auto-cashout first' : autoplayRoundsPlayed > 0 ? 'Autoplay already running' : balance <= 0 ? 'Insufficient balance' : 'Start autoplay'}
						>
							Start Autoplay
						</button>
					{/if}
				</div>
			</div>
		</div>

		<div class="history-section">
			<div class="history-header">
				<h2>Game History</h2>
			</div>
			<div class="history-table-wrapper">
				<table class="history-table">
					<thead>
						<tr>
							<th>Round ID</th>
							<th>Bet</th>
							<th>Outcome</th>
							<th>Payout</th>
							<th>Auto CO</th>
							<th>Autoplay</th>
						</tr>
					</thead>
					<tbody>
						{#each gameHistory as round (round.roundId)}
							<tr class={round.outcome === 'Cashed Out' ? 'win' : 'loss'}>
								<td class="mono">{round.roundId}</td>
								<td>${round.betAmount.toFixed(2)}</td>
								<td>{round.outcome}</td>
								<td>${round.cashoutAmount.toFixed(2)}</td>
								<td>{round.autoCashoutTriggered ? 'Yes' : 'No'}</td>
								<td>{round.autoplayStatus}</td>
							</tr>
						{/each}
						{#if gameHistory.length === 0}
							<tr>
								<td colspan="6" class="empty">No games played yet</td>
							</tr>
						{/if}
					</tbody>
				</table>
			</div>
		</div>
	</div>

	{#if isVerifyModalOpen && currentRoundId}
		<div class="modal-overlay" on:click={() => isVerifyModalOpen = false}>
			<div class="modal-content" on:click|stopPropagation>
				<div class="modal-header">
					<h2>Verify Round Fairness</h2>
					<button class="modal-close" on:click={() => isVerifyModalOpen = false}>&times;</button>
				</div>

				<div class="modal-body">
					<div class="round-info-section">
						<div class="info-item">
							<span class="label">Round ID:</span>
							<span class="mono">{currentRoundId}</span>
						</div>
						<div class="info-item">
							<span class="label">Committed Hash:</span>
							<span class="mono">{serverSeedHash}</span>
						</div>
					</div>

					<button class="verify-modal-btn" on:click={verifyFairness} disabled={isVerifying}>
						{#if isVerifying}Verifying...{:else}Verify Fairness{/if}
					</button>

					{#if verificationMessage}
						<div class="verification-result">{verificationMessage}</div>
					{/if}

					{#if revealedServerSeed && (hashVerified !== null)}
						<div class="verification-details-modal">
							<div class="detail-row">
								<span class="label">Server Seed:</span>
								<span class="mono">{revealedServerSeed}</span>
							</div>
							<div class="detail-row">
								<span class="label">Committed Hash:</span>
								<span class="mono">{serverSeedHash}</span>
							</div>
							<div class="detail-row">
								<span class="label">Computed Hash:</span>
								<span class={`mono ${hashVerified ? 'verified' : 'mismatch'}`}>
									{computedHash}
									{#if hashVerified}
										<span class="check">✓</span>
									{:else}
										<span class="x">✗</span>
									{/if}
								</span>
							</div>
							<div class="detail-row">
								<span class="label">Client Seed:</span>
								<span class="mono">{clientSeed}</span>
							</div>
							<div class="detail-row">
								<span class="label">Nonce:</span>
								<span class="mono">{nonce}</span>
							</div>
							<div class="detail-row">
								<span class="label">Crash Point:</span>
								<span class="mono">{crashPoint.toFixed(2)}x</span>
							</div>
						</div>
					{/if}
				</div>
			</div>
		</div>
	{/if}
</div>

<style>
	.crash-game-container {
		width: 100%;
		height: 100vh;
		background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
		display: flex;
		flex-direction: column;
		font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
		color: #fff;
		overflow: hidden;
	}

	.game-header {
		position: absolute;
		top: 20px;
		left: 20px;
		right: 20px;
		display: flex;
		justify-content: space-between;
		align-items: center;
		width: calc(100% - 40px);
		z-index: 10;
	}

	.game-header h1 {
		margin: 0;
		font-size: 28px;
		color: #00d4ff;
	}

	.game-layout {
		display: flex;
		flex: 1;
		gap: 20px;
		padding: 100px 20px 20px 20px;
		overflow: hidden;
	}

	.game-section {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 20px;
		min-width: 0;
	}

	.history-section {
		width: 350px;
		display: flex;
		flex-direction: column;
		background: rgba(0, 0, 0, 0.3);
		border-radius: 12px;
		padding: 15px;
		border: 1px solid rgba(0, 212, 255, 0.2);
	}

	.history-header {
		margin-bottom: 10px;
	}

	.history-header h2 {
		margin: 0;
		font-size: 16px;
		color: #00d4ff;
	}

	.history-table-wrapper {
		flex: 1;
		overflow-y: auto;
		border-radius: 8px;
	}

	.history-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 11px;
	}

	.history-table thead {
		position: sticky;
		top: 0;
		background: rgba(0, 212, 255, 0.1);
	}

	.history-table th {
		padding: 8px 4px;
		text-align: left;
		color: #00d4ff;
		font-weight: 600;
		border-bottom: 1px solid rgba(0, 212, 255, 0.3);
	}

	.history-table td {
		padding: 6px 4px;
		border-bottom: 1px solid rgba(255, 255, 255, 0.1);
	}

	.history-table tbody tr.win {
		background: rgba(0, 255, 100, 0.05);
	}

	.history-table tbody tr.loss {
		background: rgba(255, 100, 100, 0.05);
	}

	.history-table tbody tr:hover {
		background: rgba(0, 212, 255, 0.1);
	}

	.history-table .mono {
		font-family: monospace;
		font-size: 10px;
		color: #00d4ff;
	}

	.history-table .empty {
		text-align: center;
		color: #999;
		padding: 20px 4px;
	}

	.balance-info {
		display: flex;
		gap: 20px;
	}

	.balance {
		display: flex;
		gap: 10px;
		align-items: center;
		background: rgba(0, 212, 255, 0.1);
		padding: 10px 20px;
		border-radius: 8px;
		border: 2px solid #00d4ff;
	}

	.balance .label {
		color: #888;
		font-size: 14px;
	}

	.balance .value {
		color: #00d4ff;
		font-weight: bold;
		font-size: 18px;
	}

	.game-board {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		max-width: 600px;
	}

	.crash-display {
		background: rgba(0, 212, 255, 0.05);
		border: 3px solid #00d4ff;
		border-radius: 12px;
		padding: 40px;
		text-align: center;
		width: 100%;
		aspect-ratio: 1;
		display: flex;
		flex-direction: column;
		justify-content: flex-start;
		align-items: center;
		gap: 20px;
		padding-top: 20px;
	}

	.multiplier-text {
		font-size: 72px;
		font-weight: bold;
		min-height: 100px;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.multiplier-text .active {
		color: #00ff88;
		animation: pulse 0.5s infinite;
	}

	.multiplier-text .crashed {
		color: #ff4444;
	}

	.multiplier-text .waiting {
		color: #888;
	}

	@keyframes pulse {
		0%, 100% {
			opacity: 1;
		}
		50% {
			opacity: 0.5;
		}
	}

	.game-status {
		font-size: 18px;
		color: #aaa;
		min-height: 24px;
	}

	.crash-point-info {
		margin-top: 20px;
		padding-top: 20px;
		border-top: 1px solid rgba(0, 212, 255, 0.2);
		font-size: 14px;
		color: #888;
		display: flex;
		gap: 10px;
		justify-content: center;
		align-items: center;
	}

	.crash-point-info .label {
		color: #666;
	}

	.crash-point-info .value {
		color: #00d4ff;
		font-weight: 600;
	}

	.autoplay-summary {
		margin-top: 30px;
		padding: 20px;
		background: linear-gradient(135deg, rgba(0, 212, 255, 0.15) 0%, rgba(0, 255, 100, 0.1) 100%);
		border: 2px solid rgba(0, 212, 255, 0.3);
		border-radius: 12px;
		animation: slideIn 0.4s ease-out;
	}

	.autoplay-summary-compact {
		margin-top: 10px;
		padding: 8px 12px;
		background: rgba(0, 212, 255, 0.08);
		border: 1px solid rgba(0, 212, 255, 0.2);
		border-radius: 8px;
		animation: slideIn 0.3s ease-out;
	}

	@keyframes slideIn {
		from {
			opacity: 0;
			transform: translateY(10px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.autoplay-summary h3 {
		margin: 0 0 15px 0;
		color: #00d4ff;
		font-size: 18px;
		text-align: center;
	}

	.summary-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 15px;
	}

	.summary-grid-compact {
		display: grid;
		grid-template-columns: 1fr 1fr 1fr 1fr;
		gap: 8px;
	}

	.summary-item {
		display: flex;
		flex-direction: column;
		gap: 5px;
		padding: 10px;
		background: rgba(0, 0, 0, 0.2);
		border-radius: 6px;
		border: 1px solid rgba(255, 255, 255, 0.1);
	}

	.summary-item-compact {
		display: flex;
		flex-direction: column;
		gap: 3px;
		padding: 4px 6px;
		background: rgba(0, 0, 0, 0.2);
		border-radius: 4px;
		border: 1px solid rgba(255, 255, 255, 0.08);
		text-align: center;
	}

	.summary-item.win {
		background: rgba(0, 255, 100, 0.1);
		border-color: rgba(0, 255, 100, 0.3);
	}

	.summary-item-compact.win {
		background: rgba(0, 255, 100, 0.1);
		border-color: rgba(0, 255, 100, 0.3);
	}

	.summary-item.loss {
		background: rgba(255, 100, 100, 0.1);
		border-color: rgba(255, 100, 100, 0.3);
	}

	.summary-item-compact.loss {
		background: rgba(255, 100, 100, 0.1);
		border-color: rgba(255, 100, 100, 0.3);
	}

	.summary-item .label {
		font-size: 12px;
		color: #888;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}

	.summary-item-compact .label {
		font-size: 9px;
		color: #666;
		text-transform: uppercase;
		letter-spacing: 0.3px;
	}

	.summary-item .value {
		font-size: 18px;
		font-weight: 600;
		color: #00d4ff;
	}

	.summary-item-compact .value {
		font-size: 13px;
		font-weight: 600;
		color: #00d4ff;
	}

	.summary-item.win .value {
		color: #00ff88;
	}

	.summary-item-compact.win .value {
		color: #00ff88;
	}

	.summary-item.loss .value {
		color: #ff9999;
	}

	.summary-item-compact.loss .value {
		color: #ff9999;
	}

	.summary-item .value.profit {
		color: #00ff88;
	}

	.summary-item-compact .value.profit {
		color: #00ff88;
	}

	.summary-item .value.loss-color {
		color: #ff6666;
	}

	.summary-item-compact .value.loss-color {
		color: #ff6666;
	}

	.betting-section {
		position: absolute;
		bottom: 40px;
		left: 50%;
		transform: translateX(-50%);
		width: calc(100% - 80px);
		max-width: 500px;
	}

	.settings-row {
		display: flex;
		gap: 20px;
		margin-bottom: 20px;
		flex-wrap: wrap;
	}

	.input-group {
		display: flex;
		gap: 8px;
		align-items: center;
		flex: 1;
		min-width: 200px;
	}

	.input-group label {
		color: #888;
		white-space: nowrap;
		display: flex;
		align-items: center;
		gap: 5px;
	}

	.input-group input[type="checkbox"] {
		width: 16px;
		height: 16px;
		cursor: pointer;
	}

	.input-group input[type="number"] {
		padding: 8px 12px;
		background: rgba(0, 212, 255, 0.1);
		border: 2px solid #00d4ff;
		color: #fff;
		border-radius: 4px;
		font-size: 14px;
		flex: 1;
		min-width: 60px;
	}

	.input-group input[type="number"]:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.input-group span {
		color: #888;
		font-weight: bold;
	}

	.button-group {
		display: flex;
		gap: 10px;
	}

	button {
		flex: 1;
		padding: 15px 20px;
		font-size: 16px;
		font-weight: bold;
		border: none;
		border-radius: 6px;
		cursor: pointer;
		transition: all 0.3s ease;
		height: 50px;
		min-width: 120px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	button:not(.cashout):not(.autoplay-btn) {
		background: #00d4ff;
		color: #000;
	}

	button:not(.cashout):not(.autoplay-btn):hover:not(:disabled) {
		background: #00ffff;
		transform: translateY(-2px);
		box-shadow: 0 6px 20px rgba(0, 212, 255, 0.4);
	}

	button:not(.cashout):not(.autoplay-btn):disabled {
		background: #444;
		color: #888;
		cursor: not-allowed;
	}

	.cashout {
		background: #00ff88;
		color: #000;
	}

	.cashout:hover {
		background: #00ffaa;
		transform: translateY(-2px);
		box-shadow: 0 6px 20px rgba(0, 255, 136, 0.4);
	}

	.autoplay-btn {
		background: #ff9900;
		color: #000;
	}

	.autoplay-btn:hover:not(:disabled) {
		background: #ffaa11;
		transform: translateY(-2px);
		box-shadow: 0 6px 20px rgba(255, 153, 0, 0.4);
	}

	.autoplay-btn:disabled {
		background: #444;
		color: #888;
		cursor: not-allowed;
	}

	.autoplay-status {
		padding: 12px 15px;
		background: rgba(255, 153, 0, 0.1);
		border: 2px solid #ff9900;
		border-radius: 6px;
		color: #ff9900;
		font-weight: bold;
		text-align: center;
		margin-bottom: 15px;
	}

	.verification-controls {
		display: flex;
		flex-direction: column;
		gap: 10px;
		align-items: center;
		justify-content: center;
	}

	.verify-btn {
		background: #8a2be2;
		color: #fff;
	}

	.verify-btn:hover:not(:disabled) {
		background: #9b4be8;
		transform: translateY(-2px);
		box-shadow: 0 6px 20px rgba(138, 43, 226, 0.4);
	}

	.verify-btn:disabled {
		background: #444;
		color: #888;
		cursor: not-allowed;
	}

	.verification-result {
		font-size: 14px;
		color: #00d4ff;
	}

	.verification-details {
		display: flex;
		flex-direction: column;
		gap: 8px;
		background: rgba(138, 43, 226, 0.1);
		border: 1px solid rgba(138, 43, 226, 0.3);
		border-radius: 6px;
		padding: 10px;
		width: 100%;
		max-width: 400px;
		margin-top: 10px;
	}

	.detail-row {
		display: flex;
		gap: 10px;
		align-items: center;
		font-size: 12px;
	}

	.detail-row .label {
		color: #888;
		min-width: 120px;
		text-align: right;
	}

	.detail-row .mono {
		font-family: monospace;
		color: #00d4ff;
	}

	.detail-row .mono.small {
		font-size: 10px;
	}

	.detail-row .mono.verified {
		color: #00ff88;
	}

	.detail-row .mono.mismatch {
		color: #ff6666;
	}

	.detail-row .check {
		color: #00ff88;
		font-weight: bold;
		margin-left: 5px;
	}

	.detail-row .x {
		color: #ff6666;
		font-weight: bold;
		margin-left: 5px;
	}

	.round-id-button {
		background: none;
		border: none;
		color: #00d4ff;
		font-weight: bold;
		cursor: pointer;
		font-family: monospace;
		font-size: 14px;
		padding: 4px 8px;
		border-radius: 4px;
		transition: all 0.2s ease;
	}

	.round-id-button:hover {
		background: rgba(0, 212, 255, 0.1);
		text-decoration: underline;
	}

	/* Modal styles */
	.modal-overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(0, 0, 0, 0.7);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
		animation: fadeIn 0.2s ease;
	}

	@keyframes fadeIn {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}

	.modal-content {
		background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
		border: 2px solid #00d4ff;
		border-radius: 12px;
		max-width: 600px;
		max-height: 90vh;
		overflow-y: auto;
		animation: slideUp 0.3s ease;
	}

	@keyframes slideUp {
		from {
			transform: translateY(20px);
			opacity: 0;
		}
		to {
			transform: translateY(0);
			opacity: 1;
		}
	}

	.modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 20px;
		border-bottom: 1px solid rgba(0, 212, 255, 0.2);
	}

	.modal-header h2 {
		margin: 0;
		color: #00d4ff;
		font-size: 20px;
	}

	.modal-close {
		background: none;
		border: none;
		color: #00d4ff;
		font-size: 28px;
		cursor: pointer;
		padding: 0;
		width: 30px;
		height: 30px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 4px;
		transition: all 0.2s ease;
	}

	.modal-close:hover {
		background: rgba(0, 212, 255, 0.1);
		color: #fff;
	}

	.modal-body {
		padding: 20px;
		display: flex;
		flex-direction: column;
		gap: 15px;
		color: #fff;
	}

	.round-info-section {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 15px;
		background: rgba(0, 212, 255, 0.05);
		border: 1px solid rgba(0, 212, 255, 0.2);
		border-radius: 8px;
	}

	.round-info-section .info-item {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 10px;
	}

	.round-info-section .label {
		color: #888;
		flex-shrink: 0;
		min-width: 140px;
	}

	.round-info-section .mono {
		font-family: monospace;
		color: #00d4ff;
		word-break: break-all;
		font-size: 12px;
	}

	.verify-modal-btn {
		background: #8a2be2;
		color: #fff;
		border: none;
		padding: 12px 20px;
		border-radius: 6px;
		font-size: 14px;
		font-weight: bold;
		cursor: pointer;
		transition: all 0.3s ease;
	}

	.verify-modal-btn:hover:not(:disabled) {
		background: #9b4be8;
		transform: translateY(-2px);
		box-shadow: 0 6px 20px rgba(138, 43, 226, 0.4);
	}

	.verify-modal-btn:disabled {
		background: #444;
		color: #888;
		cursor: not-allowed;
	}

	.verification-details-modal {
		display: flex;
		flex-direction: column;
		gap: 12px;
		background: rgba(138, 43, 226, 0.1);
		border: 1px solid rgba(138, 43, 226, 0.3);
		border-radius: 8px;
		padding: 15px;
	}

	.verification-details-modal .detail-row {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 10px;
		padding: 8px 0;
		border-bottom: 1px solid rgba(138, 43, 226, 0.15);
	}

	.verification-details-modal .detail-row:last-child {
		border-bottom: none;
	}

	.verification-details-modal .label {
		color: #888;
		flex-shrink: 0;
		min-width: 120px;
		font-size: 12px;
	}

	.verification-details-modal .mono {
		font-family: monospace;
		color: #00d4ff;
		word-break: break-all;
		font-size: 11px;
		flex: 1;
	}

	.verification-details-modal .mono.verified {
		color: #00ff88;
	}

	.verification-details-modal .mono.mismatch {
		color: #ff6666;
	}

	.verification-details-modal .check {
		color: #00ff88;
		font-weight: bold;
		margin-left: 5px;
	}

	.verification-details-modal .x {
		color: #ff6666;
		font-weight: bold;
		margin-left: 5px;
	}
</style>
