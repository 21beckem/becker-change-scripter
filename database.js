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
		return this.#run(sqlString)
	}
	async #updateTzOffset() {
		const { recordsets } = await this.#run('SELECT DATEPART(TZ, SYSDATETIMEOFFSET()) AS TZOffset')
		const offset = recordsets[0][1][0]
		this.#tzOffset = (offset || 0) * 60 * 1000
	}
	async #run(sqlString) {
		const request = this.#pool.request()
		const messages = []
		request.on('info', info => messages.push(info.message))

		const result = await request.query(sqlString)

		const recordsets = result.recordsets.map(recordset => {
			const columns = Object.keys(recordset.columns)
			const rows = recordset.map(row => columns.map(col => this.#correctTimezone(row[col])))
			return [columns, ...rows]
		})

		return { recordsets, messages }
	}
	#correctTimezone(value) {
		if (!(value instanceof Date)) return value
		return new Date(value.getTime() - this.#tzOffset)
	}
}

module.exports = Database