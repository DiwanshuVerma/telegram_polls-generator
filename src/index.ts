import { Hono } from 'hono'

type Bindings = {
	BOT_TOKEN: string
	CHANNEL_USERNAME: string
	ALLOWED_USER_IDS: string
	BOT_KV: KVNamespace
}

const app = new Hono<{ Bindings: Bindings }>()

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseAllowedUserIds(value: string): number[] {
	try {
		const parsed = JSON.parse(value)
		return Array.isArray(parsed) ? parsed.map(Number) : []
	} catch {
		return value.split(',').map((id) => Number(id.trim()))
	}
}

// 🔥 Safe poll sender
async function safeSendPoll(botToken: string, payload: any) {
	let retries = 3

	while (retries > 0) {
		const res = await fetch(
			`https://api.telegram.org/bot${botToken}/sendPoll`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			}
		)

		const data: any = await res.json()

		if (data.ok) return { success: true }

		if (data.error_code === 429) {
			const wait = data.parameters?.retry_after || 3
			await sleep(wait * 1000)
			retries--
			continue
		}

		return { success: false, error: data.description }
	}

	return { success: false, error: 'Max retries exceeded' }
}

// 🔥 MAIN HANDLER (non-blocking)
app.post('/', async (c) => {
	const update = await c.req.json()

	// respond immediately
	c.executionCtx.waitUntil(processUpdate(c, update))

	return c.text('ok')
})

// 🔥 PROCESS LOGIC
async function processUpdate(c: any, update: any) {
	const { BOT_TOKEN, CHANNEL_USERNAME, ALLOWED_USER_IDS, BOT_KV } = c.env

	const allowedUserIds = parseAllowedUserIds(ALLOWED_USER_IDS)
	const message = update.message

	if (!message) return

	// 🔐 user check
	if (!message.from?.id || !allowedUserIds.includes(message.from.id)) return

	if (!message.document) return
	if (!message.document.file_name?.endsWith('.json')) return

	const updateKey = `update:${update.update_id}`

	// 🔥 DUPLICATE PROTECTION
	const alreadyProcessed = await BOT_KV.get(updateKey)
	if (alreadyProcessed) return

	await BOT_KV.put(updateKey, '1', { expirationTtl: 3600 }) // 1 hour

	// 🔥 LOCK SYSTEM (prevent multiple uploads)
	const lock = await BOT_KV.get('processing_lock')
	if (lock) {
		await sendMessage(BOT_TOKEN, message.from.id, '⚠️ Another upload is running, try later')
		return
	}

	await BOT_KV.put('processing_lock', '1', { expirationTtl: 600 }) // 10 min lock

	try {

		const fileId = message.document.file_id

		const fileRes = await fetch(
			`https://api.telegram.org/bot${BOT_TOKEN}/getFile`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ file_id: fileId })
			}
		)

		const fileData: any = await fileRes.json()
		if (!fileData.ok) throw new Error('File fetch failed')

		const filePath = fileData.result.file_path

		const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`
		const jsonFile = await fetch(fileUrl)
		const text = await jsonFile.text()

		const questions = JSON.parse(text)

		if (!Array.isArray(questions)) throw new Error('Invalid JSON')

		await sleep(2000)

		await sendMessage(
			BOT_TOKEN,
			message.from.id,
			`📤 Upload started... total ${questions.length}`
		)

		let success = 0
		let failed = 0

		for (let i = 0; i < questions.length; i++) {
			const q = questions[i]

			const pollPayload: any = {
				chat_id: CHANNEL_USERNAME,
				question: q.Question,
				options: q.Options,
				type: "quiz",
				correct_option_id: q.Correct_option,
				is_anonymous: true
			}

			if (q.Explanation) {
				pollPayload.explanation = q.Explanation
			}

			const result = await safeSendPoll(BOT_TOKEN, pollPayload)

			if (result.success) success++
			else failed++

			await sleep(4000)

			if ((i + 1) % 10 === 0) {
				await sendMessage(
					BOT_TOKEN,
					message.from.id,
					`📊 Progress: ${i + 1}/${questions.length}`
				)
			}
		}

		await sendMessage(
			BOT_TOKEN,
			message.from.id,
			`✅ ${success} done\n❌ ${failed} failed`
		)

	} catch (err: any) {
		await sendMessage(BOT_TOKEN, message.from.id, `❌ Error: ${err.message}`)
	}

	// 🔓 release lock
	await BOT_KV.delete('processing_lock')
}

async function sendMessage(botToken: string, chatId: number, text: string) {
	await fetch(
		`https://api.telegram.org/bot${botToken}/sendMessage`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ chat_id: chatId, text })
		}
	)
}

export default app