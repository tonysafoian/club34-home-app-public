const fs = require('fs');
const path = require('path');

function replaceInFile(filePath, replacements) {
    if (!fs.existsSync(filePath)) {
        console.log("File not found: " + filePath);
        return;
    }
    let content = fs.readFileSync(filePath, 'utf8');
    let original = content;
    for (let r of replacements) {
        content = content.split(r[0]).join(r[1]);
    }
    if (content !== original) {
        fs.writeFileSync(filePath, content, 'utf8');
        console.log("Updated: " + filePath);
    }
}

// 1. JanusLogo & JanusStatusCard files
replaceInFile('src/components/brand/JanusLogo.tsx', [
    ['Club34Logo', 'JanusLogo'],
    ['Club34Emoji', 'JanusEmoji'],
    ['Household OS', 'Janus'],
    ['Club 34', 'Janus'],
    ['Club34', 'Janus']
]);

replaceInFile('src/components/dashboard/systems/JanusStatusCard.tsx', [
    ['Club34StatusCard', 'JanusStatusCard'],
    ['Club34 App', 'Janus'],
    ['Club34', 'Janus']
]);

// 2. CSS and Branding
replaceInFile('src/index.css', [
    ['--club34-amber', '--janus-amber'],
    ['--club34-copper', '--janus-copper'],
    ['club34-gradient', 'janus-gradient'],
    ['club34-glow-soft', 'janus-glow-soft'],
    ['club34-glow', 'janus-glow'],
    ['club34-text-gradient', 'janus-text-gradient']
]);

replaceInFile('src/hooks/useBranding.tsx', [
    ['--club34-amber', '--janus-amber'],
    ['--club34-copper', '--janus-copper']
]);

// 3. Pages and Components using CSS classes and Imports
const classUsingFiles = [
    'src/pages/Index.tsx',
    'src/pages/Install.tsx',
    'src/pages/ResetPassword.tsx',
    'src/pages/GroceryOrderRunDetail.tsx',
    'src/components/grocery/ThisWeekOrder.tsx',
    'src/components/admin/AdminTeslaActivityContent.tsx',
    'src/components/tesla/SetupWizard.tsx',
    'src/pages/Time.tsx',
    'src/pages/TimeAdmin.tsx',
    'src/components/dashboard/DashboardHeader.tsx',
    'src/components/auth/AuthPage.tsx',
    'src/components/auth/PendingApproval.tsx',
    'src/components/auth/ProtectedRoute.tsx',
    'src/components/auth/WorkerRoute.tsx',
    'src/pages/HomeSystems.tsx'
];

classUsingFiles.forEach(f => replaceInFile(f, [
    ['--club34-amber', '--janus-amber'],
    ['--club34-copper', '--janus-copper'],
    ['club34-gradient', 'janus-gradient'],
    ['club34-glow-soft', 'janus-glow-soft'],
    ['club34-glow', 'janus-glow'],
    ['club34-text-gradient', 'janus-text-gradient'],
    ['Club34Logo', 'JanusLogo'],
    ['Club34StatusCard', 'JanusStatusCard'],
    ['Loading Club34 Time', 'Loading Janus Time'],
    ['Club34 Time', 'Janus Time'],
    ['Household OS', 'Janus'],
    ['Club34 App', 'Janus'],
    ['Club 34', 'Janus'],
    ['Club34', 'Janus']
]));

// 4. Other specific files
replaceInFile('src/components/dashboard/systems/RecentUserActions.tsx', [
    ['Club34 App', 'Janus'],
    ['Club34', 'Janus']
]);
replaceInFile('src/components/dashboard/systems/RecentRequests.tsx', [
    ['Club34 App', 'Janus'],
    ['Club34', 'Janus']
]);
replaceInFile('src/components/automations/WorkflowTriggersSection.tsx', [
    ['Club34', 'Janus']
]);
replaceInFile('src/lib/irrigation/controllers.ts', [
    ['Club34', 'Janus']
]);

// 5. Notion Activity
const notionFiles = [
    'src/components/notion/NotionActivityChart.tsx',
    'src/components/notion/ProductivityTodayCard.tsx',
    'src/hooks/useNotionActivity.tsx'
];
notionFiles.forEach(f => replaceInFile(f, [
    ['club34_updates', 'janus_updates'],
    ['club34_new', 'janus_new'],
    ['club34_completions', 'janus_completions'],
    ['stackId="club34"', 'stackId="janus"'],
    ['CLUB34_DATABASE_ID', 'JANUS_DATABASE_ID'],
    ["'club34'", "'janus'"],
    ['Club34', 'Janus']
]));

// 6. Workflow triggers
replaceInFile('src/lib/workflowTriggers.ts', [
    ['club34_', 'janus_'],
    ['Club34', 'Janus'],
    ['Club 34', 'Janus']
]);

// 7. Config and Docs
const configDocs = [
    'index.html',
    'vite.config.ts',
    'package.json',
    'README.md',
    'SECURITY.md',
    '.github/PULL_REQUEST_TEMPLATE.md',
    '.github/workflows/ci.yml',
    'src/components/admin/AdminApiContent.tsx'
];
configDocs.forEach(f => replaceInFile(f, [
    ['Household OS', 'Janus'],
    ['club34-home-app-public-home-app-public', 'janus-home-app'], // Specific from instruction
    ['club34-home-app-public', 'janus-home-app'],
    ['Club 34', 'Janus'],
    ['Club34', 'Janus']
]));

// 8. Server-side files
const serverFiles = [
    'server/handlers/chat.ts',
    'server/scheduledTasks.ts'
];
serverFiles.forEach(f => replaceInFile(f, [
    ['Club 34', 'Janus'],
    ['Club34/1.0', 'Janus/1.0'],
    ['Club34', 'Janus']
]));

console.log("Done.");
