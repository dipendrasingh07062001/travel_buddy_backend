# Firebase credentials for hosting

This is deployment preparation, not a new user-facing feature. Flutter signs
users in and sends their Firebase ID tokens to our API. The Node backend also
needs its own trusted Firebase access for fresh account-status checks on sensitive
actions, push delivery and Firebase sign-in cleanup after account deletion.
The Admin private key belongs only on the backend, never in Flutter/web assets.

The existing token verification and revocation rules are unchanged. This step
does not turn on push, email or policy enforcement, create a Firebase project,
grant staff roles, change IAM, delete accounts or deploy anything.

## Supported credential sources

Keep `FIREBASE_PROJECT_ID` set to the same project used by the Flutter developer.

| Environment                                 | Configuration                                                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Current laptop                              | Keep `GOOGLE_APPLICATION_CREDENTIALS` pointing at the existing private JSON file outside this repository.                      |
| Docker/VPS with file mounts                 | Mount the private file read-only at a Linux path and set `GOOGLE_APPLICATION_CREDENTIALS` to that container path.              |
| Host with secret variables, such as Railway | Set `FIREBASE_SERVICE_ACCOUNT_JSON` to the complete original service-account JSON in a private service-scoped secret variable. |
| Host with Google workload identity          | Leave the JSON variable unset and use the platform's Application Default Credentials (ADC).                                    |

If `FIREBASE_SERVICE_ACCOUNT_JSON` is set, it takes precedence over ADC. Prefer
configuring only the intended source. An invalid explicit secret does not fall
back to a local file, workload identity or another account.

The JSON must be an object of type `service_account`, with a valid `client_email`,
a nonempty `private_key` and a `project_id` matching `FIREBASE_PROJECT_ID`.
The configured string is limited to 65,536 characters. The Firebase SDK validates
the private-key format. Only these three credential fields are passed to the SDK;
arbitrary URLs or other JSON properties do not configure our credential client.
On HTTP paths, parsing and initialization failures produce a generic
`503 AUTHENTICATION_UNAVAILABLE` without credential fragments or the original
error cause in application logs. An explicitly empty/whitespace-only or oversized
secret fails environment validation and stops startup with a sanitized error;
leave the variable entirely unset to use ADC. If push is enabled, failed Firebase
initialization can also stop startup instead of starting its delivery worker.
This does not prove that the account/key is active or has the necessary IAM roles;
those require live checks.

The app reuses its Firebase Admin instance. Restart/redeploy after changing a
credential; changing a file or secret does not replace an already cached instance.

## Railway: configuration to apply at deployment time

Do not paste your entire local `.env` into Railway. In particular, a Windows
credential path, `localhost` database URL and development CORS origins are not
production configuration.

When the correct Railway workspace, service, environment and provider readiness
have been confirmed:

1. Set `FIREBASE_PROJECT_ID` for that backend service.
2. Set one `FIREBASE_SERVICE_ACCOUNT_JSON` variable to the complete JSON from the
   selected service-account file. Use the variable value field, not a shell
   command, GitHub file, Dockerfile or Docker build argument. Do not paste it into
   chat. Do not put it into the Raw Editor as many separate service-account fields.
3. Seal the variable through Railway's variable controls. Review service/workspace
   access and limit who can change deployments, read process environments or run code.
4. Keep a secure recovery/rotation process: sealed values cannot be revealed again
   in the Railway UI/API, and they are not copied to PR/duplicated environments.
5. Review the staged configuration and redeploy, then complete the live checks below.

Railway variables can be available to builds as well as deployments; sealing is
not a reason to trust unreviewed build code. Our Dockerfile deliberately has no
Firebase-secret `ARG`/`ENV` instruction or credential-file `COPY`. Keep secrets
out of build commands, caches, logs, image layers and frontend builds.

Use the original JSON text, not base64 and not an extra JSON-encoded string.
Normal JSON `\n` escapes in `private_key` are decoded by JSON parsing. Do not
manually double-escape or reformat the key. Never print the variable to debug it.
No actual Railway variable is created by this document or by the code change.

## Docker file mount alternative

For a host that supports file mounts, keep the actual key outside the source tree
and build context, and mount that individual file read-only at, for example,
`/run/secrets/firebase-admin.json`. Set the container variable:

```dotenv
GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/firebase-admin.json
```

This is the container path, not the Windows source path. The non-root `node` user
must be able to read the mounted file; grant only the required file access rather
than running the API as root or making secrets world-readable. A Compose secret
file/bind mount is not automatically an encrypted Swarm secret store. The host
file, backups and host access still need protection.

Do not put the file in the Docker image, mount a broad home/config directory,
or reuse the normal development database for a deployment rehearsal. The default
`compose.yaml` remains a local database setup; this milestone does not start a
second API or change that database.

## Verification before enabling real users

Automated tests use synthetic credentials and mocked Firebase operations. An
offline SDK initialization check can validate loading and key format, but cannot
prove IAM permissions, token status checks or notification delivery.

- Verify the chosen project/key and permissions on the intended deployed service.
- With founder-controlled test accounts, check sign-in/bootstrap, a fresh sensitive
  action, and disabled/revoked-account rejection. These may create normal test
  account records; choose the target environment deliberately.
- Check that missing/wrong credentials produce a sanitized 503, not a fallback.
- Verify FCM separately using a controlled device before enabling push.
- Test deletion/cleanup only with an explicitly disposable test account; never
  delete a real account as a credential smoke check.
- Verify health/readiness too, but do not treat either as a Firebase permission test.

No live provider operation, real-key upload, migration or production activation
is included in this credential-preparation milestone.

## Official references

- [Firebase server credential setup](https://firebase.google.com/docs/admin/setup#initialize_the_sdk_in_non-google_environments)
- [Firebase Admin cert object support](https://firebase.google.com/docs/reference/admin/node/firebase-admin.app#cert)
- [Railway variables and sealing](https://docs.railway.com/variables#sealed-variables)
- [Docker secret mechanisms and limitations](https://docs.docker.com/engine/swarm/secrets/)
