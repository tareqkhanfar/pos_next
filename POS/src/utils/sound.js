/**
 * Sound Utilities for POS
 *
 * Provides audio feedback for POS operations like adding items to cart.
 */

/**
 * Play a short beep sound for successful cart additions
 * Uses the Web Audio API to generate a pleasant notification sound
 */
export function playBeep() {
	try {
		// Check if Web Audio API is supported
		if (typeof window === 'undefined') {
			return
		}

		const AudioContextConstructor = window.AudioContext || window.webkitAudioContext
		if (!AudioContextConstructor) {
			console.warn('Web Audio API not supported in this browser')
			return
		}

		const audioContext = new AudioContextConstructor()

		// Create oscillator for the beep sound
		const oscillator = audioContext.createOscillator()
		const gainNode = audioContext.createGain()

		oscillator.connect(gainNode)
		gainNode.connect(audioContext.destination)

		// Configure beep sound
		oscillator.frequency.value = 800 // 800Hz frequency (pleasant tone)
		oscillator.type = 'sine' // Sine wave for smooth sound

		// Configure volume envelope (fade in/out for smooth sound)
		const currentTime = audioContext.currentTime
		gainNode.gain.setValueAtTime(0, currentTime)
		gainNode.gain.linearRampToValueAtTime(0.3, currentTime + 0.01) // Quick fade in
		gainNode.gain.linearRampToValueAtTime(0, currentTime + 0.1) // Fade out

		// Play the beep
		oscillator.start(currentTime)
		oscillator.stop(currentTime + 0.1) // 100ms beep duration

		// Clean up after playing
		oscillator.onended = () => {
			try {
				oscillator.disconnect()
				gainNode.disconnect()
				audioContext.close()
			} catch (e) {
				// Ignore cleanup errors
			}
		}
	} catch (error) {
		// Silently fail - don't log errors in production
	}
}

/**
 * Play an error sound
 * Uses a lower frequency for error notifications
 */
export function playErrorBeep() {
	try {
		if (typeof window === 'undefined') {
			return
		}

		const AudioContextConstructor = window.AudioContext || window.webkitAudioContext
		if (!AudioContextConstructor) {
			return
		}

		const audioContext = new AudioContextConstructor()

		const oscillator = audioContext.createOscillator()
		const gainNode = audioContext.createGain()

		oscillator.connect(gainNode)
		gainNode.connect(audioContext.destination)

		// Lower frequency for error sound
		oscillator.frequency.value = 400
		oscillator.type = 'square' // Square wave for harsher error sound

		const currentTime = audioContext.currentTime
		gainNode.gain.setValueAtTime(0, currentTime)
		gainNode.gain.linearRampToValueAtTime(0.2, currentTime + 0.01)
		gainNode.gain.linearRampToValueAtTime(0, currentTime + 0.15)

		oscillator.start(currentTime)
		oscillator.stop(currentTime + 0.15)

		oscillator.onended = () => {
			try {
				oscillator.disconnect()
				gainNode.disconnect()
				audioContext.close()
			} catch (e) {
				// Ignore cleanup errors
			}
		}
	} catch (error) {
		// Silently fail
	}
}
