const mssql = require('mssql')

class Database {
	#driver
	#config
	#pool
	#tzOffset

	constructor(config, driver = mssql) {
		this.#driver = driver
		this.#config = config
		this.#pool = null
		this.#tzOffset = 0
	}

	async connect() {
		if (this.#pool) return this.#pool
		this.#pool = await new this.#driver.ConnectionPool(this.#config).connect()
		this.#pool.on('error', () => { })
		await this.#updateTzOffset()
		return this.#pool
	}

	async close() {
		if (!this.#pool) return
		await this.#pool.close()
		this.#pool = null
	}

	async query(sqlString) {
		if (!this.#pool) throw new Error('Not connected. Call connect() first.')

		const batches = sqlString.split(/^\s*GO\s*$/im).map(b => b.trim()).filter(Boolean)
		const recordsets = []
		const messages = []

		for (const batch of batches) {
			const batchRecordsets = await this.#runBatch(batch, messages)
			if (batchRecordsets) recordsets.push(...batchRecordsets)
		}

		if (!messages.find(m => m.type === 'error'))
			messages.push({ type: 'info', message: 'Query executed successfully.' })

		return { recordsets, messages }
	}

	async #updateTzOffset() {
		const { recordsets } = await this.query('SELECT DATEPART(TZ, SYSDATETIMEOFFSET()) AS TZOffset')
		const offset = recordsets[0]?.[1]?.[0]
		this.#tzOffset = (offset || 0) * 60 * 1000
	}

	async #runBatch(sqlString, messages) {
		const request = this.#pool.request()
		request.on('info', info => messages.push({ type: 'info', message: info.message }))

		try {
			const result = await request.query(sqlString)
			return result.recordsets.map(recordset => {
				const columns = Object.keys(recordset.columns)
				const rows = recordset.map(row => columns.map(col => row[col]))
				return [columns, ...rows]
			})
		} catch (error) {
			messages.push({ type: 'error', message: error.message })
			return null
		}
	}
}

module.exports = Database