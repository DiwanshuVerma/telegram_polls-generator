import { Hono } from 'hono'

type Bindings = {
	BOT_TOKEN: string
	CHANNEL_USERNAME: string
	ALLOWED_USER_IDS: string
	mcqqueue: Queue
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

// ================= WEBHOOK =================
app.post('/', async (c) => {
	const { ALLOWED_USER_IDS, mcqqueue, BOT_KV, BOT_TOKEN } = c.env
	const allowedUserIds = parseAllowedUserIds(ALLOWED_USER_IDS)

	const update = await c.req.json()
	const message = update.message

	if (!message) return c.text('ok')

	if (!message.from?.id || !allowedUserIds.includes(message.from.id)) {
		return c.text('Unauthorized')
	}

	// 🔥 STOP COMMAND
	if (message.text && message.text.toLowerCase() === 'stop') {
		await BOT_KV.put(`stop:${message.from.id}`, '1', { expirationTtl: 600 })

		await sendMessage(BOT_TOKEN, message.from.id, '⚠️ Upload stop requested')

		return c.text('ok')
	}

	// FILE CHECK
	if (!message.document) return c.text('ok')

	if (!message.document.file_name?.toLowerCase().endsWith('.json')) {
		await sendMessage(BOT_TOKEN, message.from.id, '❌ Only JSON files allowed')
		return c.text('ok')
	}

	// PUSH TO QUEUE
	await mcqqueue.send({
		fileId: message.document.file_id,
		userId: message.from.id
	})

	await sendMessage(
		BOT_TOKEN,
		message.from.id,
		'📥 File received. Processing will start shortly...'
	)

	return c.text('ok')
})

// ================= QUEUE CONSUMER =================
export default {
	fetch: app.fetch,

	async queue(batch: MessageBatch<any>, env: Bindings) {
		const { BOT_TOKEN, CHANNEL_USERNAME, BOT_KV } = env

		for (const msg of batch.messages) {
			const { fileId, userId } = msg.body

			try {
				// Get file path
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

				await sendMessage(
					BOT_TOKEN,
					userId,
					`📤 Upload started (${questions.length} questions)\n\nType "stop" to cancel`
				)

				let success = 0
				let failed = 0

				for (let i = 0; i < questions.length; i++) {
					// 🔥 STOP CHECK
					const stop = await BOT_KV.get(`stop:${userId}`)
					if (stop) {
						await sendMessage(BOT_TOKEN, userId, '🛑 Upload stopped')
						await BOT_KV.delete(`stop:${userId}`)
						break
					}

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

					const res = await fetch(
						`https://api.telegram.org/bot${BOT_TOKEN}/sendPoll`,
						{
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify(pollPayload)
						}
					)

					const data: any = await res.json()

					if (data.ok) {
						success++
					} else {
						failed++

						await sendMessage(
							BOT_TOKEN,
							userId,
							`❌ Q${q.Question_number || i + 1} failed:\n${data.description}`
						)
					}

					// Safe delay
					await sleep(4000)

					// Progress update
					if ((i + 1) % 10 === 0) {
						await sendMessage(
							BOT_TOKEN,
							userId,
							`📊 Progress: ${i + 1}/${questions.length}`
						)
					}
				}

				await sendMessage(
					BOT_TOKEN,
					userId,
					`✅ ${success} polls posted\n❌ ${failed} failed`
				)

			} catch (err: any) {
				await sendMessage(
					env.BOT_TOKEN,
					userId,
					`❌ Error: ${err.message}`
				)
			}

			msg.ack()
		}
	}
}

// ================= HELPER =================
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