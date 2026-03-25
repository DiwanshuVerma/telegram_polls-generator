import { Hono } from 'hono'

type Bindings = {
	BOT_TOKEN: string
	CHANNEL_USERNAME: string
	ALLOWED_USER_IDS: string
}

const app = new Hono<{ Bindings: Bindings }>()

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseAllowedUserIds(value: string): number[] {
	const trimmed = value.trim()

	if (trimmed.startsWith('[')) {
		try {
			const parsed = JSON.parse(trimmed)
			if (Array.isArray(parsed)) {
				return parsed
					.map((id) => Number(id))
					.filter((id) => Number.isInteger(id) && id > 0)
			}
		} catch {
			return []
		}
	}

	return trimmed
		.split(',')
		.map((id) => Number(id.trim()))
		.filter((id) => Number.isInteger(id) && id > 0)
}

// 🔥 Safe poll sender with retry
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

		// Handle rate limit
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

app.post('/', async (c) => {
	const { BOT_TOKEN, CHANNEL_USERNAME, ALLOWED_USER_IDS } = c.env
	const allowedUserIds = parseAllowedUserIds(ALLOWED_USER_IDS)

	const update = await c.req.json()
	const message = update.message

	if (!message) return c.text('ok')

	// 🔐 Restrict users
	if (!message.from?.id || !allowedUserIds.includes(message.from.id)) {
		return c.text('Unauthorized')
	}

	if (!message.document) {
		await sendMessage(BOT_TOKEN, message.from.id, '❌ Please upload a JSON file')
		return c.text('No document')
	}

	if (!message.document.file_name?.endsWith('.json')) {
		await sendMessage(BOT_TOKEN, message.from.id, '❌ Only JSON files allowed')
		return c.text('Invalid file')
	}

	const fileId = message.document.file_id

	// 📥 Get file path
	const fileRes = await fetch(
		`https://api.telegram.org/bot${BOT_TOKEN}/getFile`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ file_id: fileId })
		}
	)

	const fileData: any = await fileRes.json()

	if (!fileData.ok) {
		await sendMessage(BOT_TOKEN, message.from.id, '❌ Failed to fetch file')
		return c.text('error')
	}

	const filePath = fileData.result.file_path

	// 📥 Download JSON
	const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`
	const jsonFile = await fetch(fileUrl)
	const text = await jsonFile.text()

	let questions

	try {
		questions = JSON.parse(text)
	} catch {
		await sendMessage(BOT_TOKEN, message.from.id, '❌ Invalid JSON format')
		return c.text('Invalid JSON')
	}

	if (!Array.isArray(questions)) {
		await sendMessage(BOT_TOKEN, message.from.id, '❌ JSON must contain an array')
		return c.text('Invalid JSON structure')
	}

	// 🔥 Cold start fix
	await sleep(2000)

	await sendMessage(
		BOT_TOKEN,
		message.from.id,
		`📤 Upload started... total ${questions.length} polls`
	)

	let success = 0
	let failed = 0

	for (let i = 0; i < questions.length; i++) {
		const q = questions[i]

		const questionNumber = q.Question_number
		const questionText = q.Question
		const options = q.Options
		const correctOption = q.Correct_option
		const explanation = q.Explanation

		// ✅ Validation
		if (
			typeof questionNumber !== 'number' ||
			typeof questionText !== 'string' ||
			!Array.isArray(options) ||
			options.length < 2 ||
			typeof correctOption !== 'number'
		) {
			failed++
			continue
		}

		if (!questionText.includes(questionNumber.toString())) {
			failed++
			continue
		}

		if (correctOption < 0 || correctOption >= options.length) {
			failed++
			continue
		}

		const pollPayload: any = {
			chat_id: CHANNEL_USERNAME,
			question: questionText,
			options: options,
			type: "quiz",
			correct_option_id: correctOption,
			is_anonymous: true
		}

		if (explanation) {
			pollPayload.explanation = explanation
		}

		const result = await safeSendPoll(BOT_TOKEN, pollPayload)

		if (result.success) {
			success++
		} else {
			failed++
			await sendMessage(
				BOT_TOKEN,
				message.from.id,
				`❌ Q${questionNumber}: ${result.error}`
			)
		}

		// 🔥 Safe delay (important)
		await sleep(4000)

		// 📊 Progress update every 10
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
		`✅ ${success} polls posted\n❌ ${failed} failed`
	)

	return c.text('done')
})

async function sendMessage(botToken: string, chatId: number, text: string) {
	await fetch(
		`https://api.telegram.org/bot${botToken}/sendMessage`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				chat_id: chatId,
				text
			})
		}
	)
}

export default app
