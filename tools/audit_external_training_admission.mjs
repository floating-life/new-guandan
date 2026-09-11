/**
 * AI-DATA-002 / DMC-2 admission audit. Fail closed. Never sets trainingEligible=true.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const AUDIT_SCHEMA = 'guandan-external-training-admission-audit-v1';
export const FORBIDDEN_OBSERVATION_KEYS = Object.freeze([
  'opponentHands', 'undealtCards', 'initialHands', 'hands', 'roundInitialHands',
]);
const rootDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function gate(status, reason, evidence = null) {
  return { status, reason, evidence };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function* jsonlRows(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\n/)) {
    if (!line.trim()) continue;
    yield JSON.parse(line);
  }
}

export function parseAdmissionArgs(argv = []) {
  const config = { write: false, outputPath: null };
  for (const arg of argv) {
    if (arg === '--write') {
      config.write = true;
      continue;
    }
    if (arg.startsWith('--output=')) {
      config.outputPath = arg.slice(9);
      continue;
    }
    if (/^--(?:admit|train|release|promotion|eligible)(?:=|$)/i.test(arg)) {
      throw new Error(`拒绝准入或训练入口: ${arg}`);
    }
    throw new Error(`未知参数: ${arg}`);
  }
  return config;
}

function artifactExists(root, relative) {
  return fs.existsSync(path.join(root, ...relative.split('/')));
}

function readmePolicy(root) {
  const file = path.join(root, '训练数据', 'README.md');
  if (!fs.existsSync(file)) {
    return { present: false, forbidsShareAndCommercial: false, fourHandWarning: false };
  }
  const text = fs.readFileSync(file, 'utf8');
  return {
    present: true,
    forbidsShareAndCommercial: /不要把本目录上传、公开分享或用于商业训练/.test(text),
    fourHandWarning: /包含四家初始牌/.test(text),
    trainingGateZero: /真正通过训练门禁的记录仍为 \*\*0\*\*/.test(text),
  };
}

export function auditExternalTrainingAdmission(root = rootDefault, options = {}) {
  if (options.argv) parseAdmissionArgs(options.argv);
  const trajPath = options.trajectoryPath
    || path.join(root, '训练数据', '验证', 'external-trajectory-v2.jsonl');
  const statusPath = options.statusPath
    || path.join(root, '训练数据', '验证', 'external-replay-status.json');
  const zipPath = options.botzoneZipReportPath
    || path.join(root, '训练数据', 'Botzone', 'reports', 'download-summary.json');

  const hasLicense = artifactExists(root, '训练数据/许可.json')
    || artifactExists(root, '训练数据/license.json');
  const hasConsent = artifactExists(root, '训练数据/consent-ledger.json');
  const hasDeletion = artifactExists(root, '训练数据/deletion-ledger.json');
  const readme = readmePolicy(root);

  let zip = { ok: false, archivesAvailable: 0 };
  if (fs.existsSync(zipPath)) zip = readJson(zipPath);

  let eligibleTrue = 0;
  let actingSeatFail = 0;
  let hiddenFail = 0;
  let schemaFail = 0;
  let fairnessFail = 0;
  let rows = 0;
  const providers = {};
  for (const row of jsonlRows(trajPath)) {
    rows += 1;
    providers[row.provider || 'unknown'] = (providers[row.provider || 'unknown'] || 0) + 1;
    if (row.schema !== 'guandan-external-trajectory-v1') schemaFail += 1;
    if (row.trainingEligible !== false) eligibleTrue += 1;
    if (row.fairness !== 'own_hand_plus_public_history_only') fairnessFail += 1;
    const seat = row.observation?.seat;
    if (!Number.isInteger(seat) || seat < 0 || seat > 3) actingSeatFail += 1;
    const obs = row.observation && typeof row.observation === 'object' ? row.observation : {};
    if (FORBIDDEN_OBSERVATION_KEYS.some((key) => Object.prototype.hasOwnProperty.call(obs, key))) {
      hiddenFail += 1;
    }
  }

  let statusEligibleTrue = 0;
  let passedReplay = 0;
  let statusEntries = 0;
  if (fs.existsSync(statusPath)) {
    const entries = readJson(statusPath).entries || [];
    statusEntries = entries.length;
    for (const entry of entries) {
      if (entry.trainingEligible !== false) statusEligibleTrue += 1;
      if (entry.projectRuleReplay === 'passed') passedReplay += 1;
    }
  }

  const licenseEvidence = {
    hasLicense,
    readmePresent: readme.present,
    readmeForbidsShareAndCommercial: readme.forbidsShareAndCommercial,
  };
  const gates = {
    license: hasLicense
      ? gate('unavailable', 'license artifact present but grant text is not parsed as an admission', licenseEvidence)
      : gate('fail', 'no license/permission artifact under 训练数据/许可.json or license.json', licenseEvidence),
    redistribution: hasLicense
      ? gate('unavailable', 'license present but redistribution grant not parsed', licenseEvidence)
      : gate('fail', 'no redistribution grant; README forbids sharing without source permission', licenseEvidence),
    commercialUse: hasLicense
      ? gate('unavailable', 'license present but commercial grant not parsed', licenseEvidence)
      : gate('fail', 'no commercial-use grant; README forbids commercial training without permission', licenseEvidence),
    deletion: hasDeletion || hasConsent
      ? gate('unavailable', 'ledger present but deletion workflow not verified', {
        hasDeletion,
        hasConsent,
      })
      : gate('fail', 'no deletion/consent ledger', { hasDeletion, hasConsent }),
    actingSeat: actingSeatFail === 0 && rows > 0 && fairnessFail === 0
      ? gate('pass', 'fair trajectory rows declare acting seat and own-hand fairness', {
        rows, fairnessFail,
      })
      : gate('fail', 'acting-seat or fairness missing on fair trajectory', {
        rows, actingSeatFail, fairnessFail,
      }),
    ruleVersion: schemaFail === 0 && rows > 0 && passedReplay > 0
      ? gate('pass', 'fair rows use project trajectory schema; some episodes passed project rule replay', {
        rows, schemaFail, passedReplay, statusEntries,
      })
      : gate('fail', 'missing project-rule replay provenance', {
        rows, schemaFail, passedReplay, statusEntries,
      }),
    hiddenCards: hiddenFail === 0 && rows > 0
      ? gate('pass', 'fair trajectory observations have no four-hand/undealt fields', {
        rows, hiddenFail, rawArchivesContainFourHands: readme.fourHandWarning,
      })
      : gate('fail', 'hidden-card fields present on observation or fair trajectory missing', {
        rows, hiddenFail,
      }),
    trainingEligibleIsolation: eligibleTrue === 0 && statusEligibleTrue === 0 && rows > 0
      ? gate('pass', 'all fair rows and status entries remain trainingEligible=false', {
        rows, statusEntries,
      })
      : gate('fail', 'trainingEligible isolation broken', {
        eligibleTrue, statusEligibleTrue, rows, statusEntries,
      }),
  };

  const technicalPass = Object.values(gates).every((item) => item.status === 'pass');
  const report = {
    schema: AUDIT_SCHEMA,
    generatedAt: new Date().toISOString(),
    diagnosticOnly: true,
    admitted: false,
    trainingEligible: false,
    neverSetsTrainingEligibleTrue: true,
    wouldAdmitIfPolicyAllowed: technicalPass,
    botzoneOfficialZip: {
      available: zip.ok === true && Number(zip.archivesAvailable) > 0,
      ok: zip.ok === true,
      archivesAvailable: Number(zip.archivesAvailable) || 0,
    },
    surfaces: {
      readme: readme.present,
      fairTrajectory: rows > 0,
      rawNjuptArchives: artifactExists(root, '训练数据/南邮/压缩包'),
      normalizedNjupt: artifactExists(root, '训练数据/标准化/njupt.jsonl'),
      botzonePublicPages: artifactExists(root, '训练数据/Botzone/raw/public_pages'),
      licenseArtifact: hasLicense,
      deletionLedger: hasDeletion || hasConsent,
    },
    providers,
    trajectoryRows: rows,
    replayStatus: { entries: statusEntries, passedReplay },
    gates,
    findings: [
      'Admission remains fail-closed. Replay success is not training eligibility.',
      'Botzone official monthly ZIP is empty and is not an admitted archive.',
      'Raw NJUPT/Botzone records stay isolated; only fair public-info trajectories were inspected.',
    ],
  };
  if (technicalPass) {
    report.findings.push('All technical isolation gates passed on paper; still refuse to set trainingEligible=true in this TASK.');
  }
  if (readme.forbidsShareAndCommercial) {
    report.findings.push('训练数据/README.md forbids upload, redistribution, and commercial training without source permission.');
  }
  report.admitted = false;
  report.trainingEligible = false;

  if (options.write === true) {
    const outputPath = options.outputPath
      || path.join(root, 'tools', 'external-training-admission-audit.json');
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    report.outputPath = outputPath;
  }
  return report;
}

export function main(argv = process.argv.slice(2)) {
  const config = parseAdmissionArgs(argv);
  const report = auditExternalTrainingAdmission(rootDefault, {
    write: config.write,
    outputPath: config.outputPath,
  });
  process.stdout.write(`${JSON.stringify({
    schema: report.schema,
    admitted: report.admitted,
    trainingEligible: report.trainingEligible,
    wouldAdmitIfPolicyAllowed: report.wouldAdmitIfPolicyAllowed,
    botzoneOfficialZip: report.botzoneOfficialZip,
    failedGates: Object.entries(report.gates)
      .filter(([, item]) => item.status !== 'pass')
      .map(([id, item]) => ({ id, status: item.status, reason: item.reason })),
  })}\n`);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.name}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
