// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @param {string} sql - Full SQL change script text
 * @returns {string}   - Rollback SQL script text
 */
function generateRollbackScript(sql) {
  const statements = parseStatements(sql);
  const rollbackBlocks = [...statements]
    .reverse()
    .map(generateRollbackBlock)
    .filter(Boolean);

  return rollbackBlocks.join('\n\n');
}

module.exports = { generateRollbackScript };

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Splits the SQL on GO separators and classifies each statement.
 * @param {string} sql
 * @returns {ParsedStatement[]}
 */
function parseStatements(sql) {
  return sql
    .split(/^GO[ \t]*$/im)
    .map(chunk => chunk.trim())
    .filter(Boolean)
    .map(classifyStatement);
}

/**
 * @typedef {Object} ParsedStatement
 * @property {'CREATE_TABLE'|'ADD_FK'|'UNKNOWN'} type
 * @property {string} raw
 * @property {string} [tableName]       - for CREATE_TABLE and ADD_FK
 * @property {InlineFK[]} [inlineFKs]   - for CREATE_TABLE
 * @property {string} [constraintName]  - for ADD_FK
 */

/**
 * @typedef {Object} InlineFK
 * @property {string} constraintName
 * @property {string} tableName  - the table it belongs to (same as parent CREATE TABLE)
 */

/**
 * Inspects a single SQL statement and returns a typed object describing it.
 * @param {string} sql
 * @returns {ParsedStatement}
 */
function classifyStatement(sql) {
  // --- CREATE TABLE ---
  const createTableMatch = sql.match(
    /CREATE\s+TABLE\s+((?:\[?\w+\]?\.)*\[?\w+\]?)\s*\(/i
  );
  if (createTableMatch) {
    const tableName = extractTableName(createTableMatch[1]);

    // Detect any inline FK constraints: CONSTRAINT <name> FOREIGN KEY ...
    const inlineFKs = [];
    const fkRe = /CONSTRAINT\s+(\[?\w+\]?)\s+FOREIGN\s+KEY/gi;
    let m;
    while ((m = fkRe.exec(sql)) !== null) {
      inlineFKs.push({
        constraintName: stripBrackets(m[1]),
        tableName,
      });
    }

    return { type: 'CREATE_TABLE', raw: sql, tableName, inlineFKs };
  }

  // --- ALTER TABLE ... ADD CONSTRAINT FK_ ---
  const addFKMatch = sql.match(
    /ALTER\s+TABLE\s+((?:\[?\w+\]?\.)*\[?\w+\]?)\s+ADD\s+CONSTRAINT\s+(\[?\w+\]?)\s+FOREIGN\s+KEY/i
  );
  if (addFKMatch) {
    return {
      type: 'ADD_FK',
      raw: sql,
      tableName: extractTableName(addFKMatch[1]),
      constraintName: stripBrackets(addFKMatch[2]),
    };
  }

  // --- Unrecognised ---
  return { type: 'UNKNOWN', raw: sql };
}

// ---------------------------------------------------------------------------
// Rollback generation
// ---------------------------------------------------------------------------

/**
 * Turns a classified statement into its rollback SQL block (or null to skip).
 * @param {ParsedStatement} stmt
 * @returns {string|null}
 */
function generateRollbackBlock(stmt) {
  switch (stmt.type) {
    case 'CREATE_TABLE': {
      const parts = [];

      // Inline FKs must be dropped before the table is dropped.
      for (const fk of stmt.inlineFKs) {
        parts.push(buildDropConstraint(fk.tableName, fk.constraintName));
      }

      parts.push(buildDropTable(stmt.tableName));
      return parts.join('\n\n');
    }

    case 'ADD_FK':
      return buildDropConstraint(stmt.tableName, stmt.constraintName);

    case 'UNKNOWN': {
      const firstLine = stmt.raw.split('\n')[0].trim();
      return `-- rollback needed here for: ${firstLine}\nGO`;
    }

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// SQL fragment builders
// ---------------------------------------------------------------------------

function buildDropTable(tableName) {
  return `DROP TABLE IF EXISTS ${dbo(tableName)};\nGO`;
}

function buildDropConstraint(tableName, constraintName) {
  return (
    `IF EXISTS(SELECT * FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_NAME = '${constraintName}') BEGIN\n` +
    `    ALTER TABLE ${dbo(tableName)} DROP CONSTRAINT ${bracket(constraintName)}\n` +
    `END\n` +
    `GO`
  );
}

// ---------------------------------------------------------------------------
// Name helpers
// ---------------------------------------------------------------------------

/** Removes surrounding square brackets if present. */
function stripBrackets(name) {
  return name.replace(/^\[/, '').replace(/\]$/, '');
}

/** Wraps a name in square brackets. */
function bracket(name) {
  return `[${stripBrackets(name)}]`;
}

/** Fully qualifies with [dbo].[name]. */
function dbo(name) {
  return `[dbo].${bracket(name)}`;
}

/**
 * Extracts just the object name from a potentially schema-qualified identifier.
 * e.g. "[dbo].[MyTable]" → "MyTable", "dbo.MyTable" → "MyTable", "MyTable" → "MyTable"
 */
function extractTableName(raw) {
  const parts = raw.split('.');
  return stripBrackets(parts[parts.length - 1]);
}