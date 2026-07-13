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

	async executeChangeScript(rollbackSql, changeSql) {
		// run rollback first
		const rollbackRes = await this.executeLargeQuery(rollbackSql, 'Rollback');
		if (!rollbackRes.success) return rollbackRes;

		// wait a breif sec to allow changes to fully take place
		// (otherwise occational errors appear)
		await new Promise(r => setTimeout(r, 250));

		// then changes
		const changeRes = await this.executeLargeQuery(changeSql, 'Changes');
		return {
			success: rollbackRes.success && changeRes.success,
			messages: [
				...rollbackRes.messages,
				...changeRes.messages,
			]
		}
	}

	async executeLargeQuery(sqlString, queryType='Query') {
		if (!this.#pool) throw new Error('Not connected. Call connect() first.')

		const batches = sqlString.split(/(?:^|\r?\n)\s*GO\s*(?:\r?\n|$)/im)

		const optimizedSql = batches
			.map(batch => {
				const trimmed = batch.trim()
				if (!trimmed) return null

				const safeSql = trimmed.replace(/'/g, "''")

				return `EXEC(N'${safeSql}');`
			})
			.filter(Boolean)
			.join('\n')

		const request = this.#pool.request()
		const messages = []

		request.on('info', info => messages.push({ type: 'info', message: info.message }))

		try {
			await request.batch(`
				SET NOCOUNT ON;
				SET XACT_ABORT ON;
				${optimizedSql}
			`)

			messages.push({ type: 'info', message: queryType + ' executed successfully.' })
			return { success: true, messages }
		} catch (error) {
			messages.push({ type: 'error', message: error.message })
			return { success: false, messages }
		}
	}

	async query(sqlString, queryType='Query') {
		if (!this.#pool) throw new Error('Not connected. Call connect() first.')

		const batches = sqlString.split(/^\s*GO\s*$/im).map(b => b.trim()).filter(Boolean)
		const recordsets = []
		const messages = []

		for (const batch of batches) {
			const batchRecordsets = await this.#runBatch(batch, messages)
			if (batchRecordsets) recordsets.push(...batchRecordsets)
		}

		if (!messages.find(m => m.type === 'error'))
			messages.push({ type: 'info', message: queryType + ' executed successfully.' })

		return { recordsets, messages }
	}

	async #updateTzOffset() {
		const request = this.#pool.request()
		const result = await request.batch('SELECT DATEPART(TZ, SYSDATETIMEOFFSET()) AS TZOffset')
		const offset = result.recordset?.[0]?.TZOffset
		this.#tzOffset = (offset || 0) * 60 * 1000
	}

	async #runBatch(sqlString, messages) {
		const request = this.#pool.request()
		request.on('info', info => messages.push({ type: 'info', message: info.message }))

		try {
			const result = await request.batch(sqlString)
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
