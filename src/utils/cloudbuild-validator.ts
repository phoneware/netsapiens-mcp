/**
 * Regression guard for Cloud Build configuration.
 *
 * Enforces that no environment variable or substitution matching SECRET|PASSWORD|TOKEN|KEY
 * contains a plaintext/literal value. Only Secret Manager references (e.g., secret-name:version
 * or full projects/.../secrets/... URIs) are permitted for secret-bearing keys.
 */

export interface SecretViolation {
 line: number;
 key: string;
 reason: string;
}

const SECRET_NAME_PATTERN = /(?:SECRET|PASSWORD|TOKEN|KEY)/i;

// Format for Secret Manager references accepted by Cloud Run:
// - name:version (e.g., netsapiens-mcp-session-secret:latest, my-secret:1)
// - projects/PROJECT/secrets/NAME/versions/VERSION
// - projects/PROJECT/secrets/NAME (defaults to latest)
const SECRET_MANAGER_REF_PATTERN =
 /^(?:projects\/[a-zA-Z0-9_-]+\/secrets\/)?[a-zA-Z0-9_-]+(?::(?:latest|[0-9]+)|\/versions\/(?:latest|[0-9]+))?$/;

/**
 * Validates the contents of a cloudbuild.yaml file.
 * Returns an array of violations found. If valid, the array is empty.
 */
export function validateCloudBuildSecrets(content: string): SecretViolation[] {
 const violations: SecretViolation[] = [];
 const lines = content.split('\n');

 for (let i = 0; i < lines.length; i++) {
  const rawLine = lines[i];
  const lineNum = i + 1;

  // Strip comments
  const commentStart = rawLine.indexOf('#');
  const line = commentStart >= 0 ? rawLine.slice(0, commentStart) : rawLine;
  if (!line.trim()) continue;

  // 1. Check --update-secrets and --set-secrets
  const secretsMatch = line.match(/--(?:update|set)-secrets(?:=|\s+)(?:\"([^\"]*)\"|'([^']*)'|(\S+))/);
  if (secretsMatch) {
   const secretsStr = (secretsMatch[1] || secretsMatch[2] || secretsMatch[3]).replace(/['\"]+$/g, '');
   const pairs = secretsStr.split(',');
   for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx > 0) {
     const key = pair.slice(0, eqIdx).trim();
     const val = pair.slice(eqIdx + 1).trim().replace(/['\"]+$/g, '');
     if (SECRET_NAME_PATTERN.test(key)) {
      // Must have a valid Secret Manager version suffix (:latest or :number or /versions/...)
      const hasVersion = /:(?:latest|[0-9]+)$|\/versions\/(?:latest|[0-9]+)$/.test(val);
      if (!hasVersion || !SECRET_MANAGER_REF_PATTERN.test(val)) {
       violations.push({
        line: lineNum,
        key,
        reason: 'Secret key has literal or invalid value instead of Secret Manager reference (name:version)',
       });
      }
     }
    }
   }
   continue;
  }

  // 2. Check --update-env-vars and --set-env-vars
  const envMatch = line.match(/--(?:update|set)-env-vars(?:=|\s+)(?:\"([^\"]*)\"|'([^']*)'|(\S+))/);
  if (envMatch) {
   const envStr = (envMatch[1] || envMatch[2] || envMatch[3]).replace(/['\"]+$/g, '');
   let pairs: string[] = [];

   // Check for custom delimiter ^DELIM^...
   if (envStr.startsWith('^')) {
    const delimEnd = envStr.indexOf('^', 1);
    if (delimEnd > 1) {
     const delim = envStr.slice(1, delimEnd);
     pairs = envStr.slice(delimEnd + 1).split(delim);
    } else {
     pairs = envStr.split(',');
    }
   } else {
    // Fallback: match all KEY=VAL occurrences
    const matches = [...envStr.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=/g)];
    for (let m = 0; m < matches.length; m++) {
     const k = matches[m][1];
     const startVal = matches[m].index! + matches[m][0].length;
     const endVal = (m + 1 < matches.length) ? matches[m + 1].index! - 1 : envStr.length;
     const v = envStr.slice(startVal, endVal).replace(/[,]+$/, '');
     pairs.push(k + '=' + v);
    }
   }

   for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx > 0) {
     const key = pair.slice(0, eqIdx).trim();
     if (SECRET_NAME_PATTERN.test(key)) {
      violations.push({
       line: lineNum,
       key,
       reason: 'Secret key configured as plain environment variable (must use Secret Manager via --update-secrets)',
      });
     }
    }
   }
   continue;
  }

  // 3. Check step env: list items (- 'KEY=val' or - KEY=val)
  const envItemMatch = line.match(/^\s*-\s*['\"]?([A-Za-z0-9_]+)=([^'\"]+)['\"]?/);
  if (envItemMatch && !line.includes('--')) {
   const key = envItemMatch[1];
   if (SECRET_NAME_PATTERN.test(key)) {
    violations.push({
     line: lineNum,
     key,
     reason: 'Secret key configured in step env list (must use Secret Manager)',
    });
    continue;
   }
  }

  // 4. Check substitutions: _KEY: val or KEY: val
  const subMatch = line.match(/^\s*(_?[A-Za-z0-9_]+):\s*['\"]?([^'\"#\s]+)/);
  if (subMatch) {
   const key = subMatch[1];
   if (SECRET_NAME_PATTERN.test(key)) {
    violations.push({
     line: lineNum,
     key,
     reason: 'Secret key configured in substitutions (must use Secret Manager)',
    });
    continue;
   }
  }

  // 5. Check inline shell assignments (export KEY=val or KEY=val) in scripts
  const shellAssign = line.match(/(?:export\s+)?\b([A-Za-z0-9_]*(?:SECRET|PASSWORD|TOKEN|KEY)[A-Za-z0-9_]*)=([^\s,;'\"]+)/);
  if (
   shellAssign &&
   !line.includes('--update-secrets') &&
   !line.includes('--set-secrets') &&
   !line.includes('--remove-env-vars') &&
   !line.includes('--update-env-vars') &&
   !line.includes('--set-env-vars')
  ) {
   violations.push({
    line: lineNum,
    key: shellAssign[1],
    reason: 'Secret key assigned in shell script (must use Secret Manager)',
   });
   continue;
  }
 }

 return violations;
}
