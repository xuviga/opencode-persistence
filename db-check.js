// SQLite Database Analysis Tool for Bun
// This script analyzes the persistence database using Bun's native SQLite

import { Database } from "bun:sqlite"
import path from "path"

const dbpath = path.join(process.env.APPDATA || process.env.HOME, 'opencode', 'memory', 'memory.db')

console.log('=== SQLite Database Analysis ===')
console.log('Database path:', dbpath)

try {
    const db = new Database(dbpath)

    // List all tables
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all()
    console.log('\n📋 Tables in database:')
    tables.forEach(t => console.log(`- ${t.name}`))

    tables.forEach(table => {
        const tableName = table.name
        const row = db.query(`SELECT COUNT(*) as count FROM ${tableName}`).get()

        console.log(`\n📊 Table "${tableName}":`)
        console.log(`- Total rows: ${row.count}`)

        // Get table structure
        const columns = db.query(`PRAGMA table_info(${tableName})`).all()
        console.log('- Columns:')
        columns.forEach(col => {
            console.log(`  - ${col.name} (${col.type})`)
        })

        // Get sample data based on table type
        if (row.count > 0) {
            if (tableName === 'sessions') {
                const sessions = db.query(`SELECT * FROM sessions LIMIT 5`).all()
                console.log('- Sample data (first 5 rows):')
                sessions.forEach((session, i) => {
                    console.log(`  ${i+1}. ID: ${session.id}, Started: ${session.started_at}, Status: ${session.status}`)
                    if (session.project_dir) {
                        console.log(`     Project: ${session.project_dir}`)
                    }
                })
            }
            else if (tableName === 'actions') {
                const actions = db.query(`SELECT * FROM actions LIMIT 5`).all()
                console.log('- Sample data (first 5 rows):')
                actions.forEach((action, i) => {
                    console.log(`  ${i+1}. Type: ${action.type}, Summary: ${action.summary}`)
                    if (action.tool) {
                        console.log(`     Tool: ${action.tool}`)
                    }
                })
            }
            else if (tableName === 'file_changes') {
                const changes = db.query(`SELECT * FROM file_changes LIMIT 5`).all()
                console.log('- Sample data (first 5 rows):')
                changes.forEach((change, i) => {
                    console.log(`  ${i+1}. File: ${change.file}, Type: ${change.change_type}`)
                })
            }
            else if (tableName === 'dialog') {
                const dialogs = db.query(`SELECT * FROM dialog LIMIT 5`).all()
                console.log('- Sample data (first 5 rows):')
                dialogs.forEach((dialog, i) => {
                    console.log(`  ${i+1}. Role: ${dialog.role}, Text: ${dialog.text.substring(0, 50)}...`)
                })
            }
            else if (tableName === 'session_errors') {
                const errors = db.query(`SELECT * FROM session_errors LIMIT 5`).all()
                console.log('- Sample data (first 5 rows):')
                errors.forEach((error, i) => {
                    console.log(`  ${i+1}. Type: ${error.error_type}, Message: ${error.message.substring(0, 50)}...`)
                })
            }
        }
    })

    db.close()
    console.log('\n✅ Database analysis complete')

} catch (error) {
    console.error('❌ Error analyzing database:', error.message)
}
