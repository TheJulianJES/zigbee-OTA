import assert from "node:assert";
import {readFileSync, renameSync} from "node:fs";
import path from "node:path";
import type * as CoreApi from "@actions/core";
import type {Octokit} from "@octokit/rest";
import {
    addImageToBase,
    addImageToPrev,
    BASE_IMAGES_DIR,
    BASE_INDEX_MANIFEST_FILENAME,
    findExistingImage,
    findMatchImage,
    getOutDir,
    getParsedImageStatus,
    getValidMetas,
    isImageFileNameMatch,
    ParsedImageStatus,
    PREV_IMAGES_DIR,
    PREV_INDEX_MANIFEST_FILENAME,
    parseImageHeader,
    UPGRADE_FILE_IDENTIFIER,
    updateImageExtraMetas,
} from "./common.js";
import type {Context, ExtraMetas, ExtraMetasWithFileName, GHExtraMetas, RepoImageMeta} from "./types.js";

const GLEDOPTO_MANUFACTURER_CODE = 4687;
const TUYA_MANUFACTURER_CODE_1 = 4098;
const TUYA_MANUFACTURER_CODE_2 = 4417;
const LUMI_UNITED_TECHOLOGY_LTD_SHENZHEN = 4447;

const EXTRA_METAS_PR_BODY_START_TAG = "```json";
const EXTRA_METAS_PR_BODY_END_TAG = "```";

/**
 * Get the extra metas for a changed file (`filePath` as `images/Manuf/abc.ota`).
 * In array form, the first entry designating the file is used (the same entry can designate several files).
 * @see isImageFileNameMatch
 */
function getFileExtraMetas(extraMetas: GHExtraMetas, filePath: string): ExtraMetas {
    if (Array.isArray(extraMetas)) {
        // `fileName` is only a designation and `fileVersion` only a selector for existing images, neither must be written to manifest
        // @see getValidMetas
        const {
            fileName: _fileName,
            fileVersion: _fileVersion,
            ...fileExtraMetas
        } = extraMetas.find((m) => isImageFileNameMatch(m.fileName!, filePath)) ?? {};

        return fileExtraMetas;
    }

    // not an array, use same metas for all files
    return extraMetas;
}

async function getPRBody(github: Octokit, _core: typeof CoreApi, context: Context): Promise<string | undefined> {
    assert(context.payload.pull_request || context.eventName === "push");

    if (context.payload.pull_request) {
        return context.payload.pull_request.body;
    }

    if (context.eventName === "push") {
        const pushMsg = context.payload.head_commit.message as string;
        const prMatch = pushMsg.match(/\(#(\d+)\)/);

        if (prMatch) {
            const prNumber = Number.parseInt(prMatch[1], 10);

            try {
                const pr = await github.rest.pulls.get({
                    owner: context.repo.owner,
                    repo: context.repo.repo,
                    pull_number: prNumber,
                });

                return pr.data.body || undefined;
            } catch (error) {
                throw new Error(`Failed to get PR#${prNumber} for extra metas: ${error}`);
            }
            /* v8 ignore start */
        } else {
        }
    } else {
    }
    /* v8 ignore stop */
}

async function parsePRBodyExtraMetas(github: Octokit, core: typeof CoreApi, context: Context): Promise<GHExtraMetas> {
    let extraMetas: GHExtraMetas = {};

    const prBody = await getPRBody(github, core, context);

    if (prBody) {
        try {
            const metasStart = prBody.indexOf(EXTRA_METAS_PR_BODY_START_TAG);
            const metasEnd = prBody.lastIndexOf(EXTRA_METAS_PR_BODY_END_TAG);

            if (metasStart !== -1 && metasEnd > metasStart) {
                const metas = JSON.parse(prBody.slice(metasStart + EXTRA_METAS_PR_BODY_START_TAG.length, metasEnd)) as GHExtraMetas;

                core.info("Extra metas from PR body:");
                core.info(JSON.stringify(metas, undefined, 2));

                if (Array.isArray(metas)) {
                    extraMetas = [];

                    for (const meta of metas) {
                        if (!meta.fileName || typeof meta.fileName !== "string") {
                            core.info("Ignoring meta in array with missing/invalid fileName:");
                            core.info(JSON.stringify(meta, undefined, 2));
                            continue;
                        }

                        const validMetas = getValidMetas(meta, false);

                        if (meta.fileVersion != null) {
                            if (typeof meta.fileVersion !== "number") {
                                throw new Error(`Invalid format for 'fileVersion', expected 'number' type.`);
                            }

                            validMetas.fileVersion = meta.fileVersion;
                        }

                        extraMetas.push(validMetas);
                    }
                } else {
                    extraMetas = getValidMetas(metas, false);
                }
            } /* v8 ignore start */ else {
            }
            /* v8 ignore stop */
        } catch (error) {
            throw new Error(`Invalid extra metas in pull request body: ${(error as Error).message}`);
        }
    }

    return extraMetas;
}

/**
 * Apply extra metas declared in the PR body for images that are not part of the changed files (existing images in the manifests).
 *
 * Fields not present in the declared extra metas are kept as-is (merge, not replace).
 * Images are looked up in both base and prev manifests (`fileVersion` can be used to select between the two).
 */
function updateExistingImagesExtraMetas(
    core: typeof CoreApi,
    updateMetas: ExtraMetasWithFileName[],
    baseManifest: RepoImageMeta[],
    prevManifest: RepoImageMeta[],
): void {
    for (const updateMeta of updateMetas) {
        const fileName = updateMeta.fileName!;
        const logPrefix = `[${fileName}]`;

        core.startGroup(fileName);

        try {
            const extraMetas = getValidMetas(updateMeta, true);

            if (Object.keys(extraMetas).length === 0) {
                throw new Error("No valid extra metas to update for existing image");
            }

            const image = findExistingImage([...baseManifest, ...prevManifest], fileName, updateMeta.fileVersion, extraMetas);

            if (!image) {
                throw new Error(
                    "Image not found in changed files nor in existing manifests. Check `fileName` matches the exact file name of the image",
                );
            }

            core.info(`${logPrefix} Found in ${baseManifest.includes(image) ? BASE_INDEX_MANIFEST_FILENAME : PREV_INDEX_MANIFEST_FILENAME}.`);

            updateImageExtraMetas(logPrefix, image, extraMetas);
        } catch (error) {
            core.endGroup();
            throw new Error(`${logPrefix} ${(error as Error).message}`);
        }

        core.endGroup();
    }
}

export async function processOtaFiles(
    github: Octokit,
    core: typeof CoreApi,
    context: Context,
    filePaths: string[],
    baseManifest: RepoImageMeta[],
    prevManifest: RepoImageMeta[],
): Promise<void> {
    const extraMetas = await parsePRBodyExtraMetas(github, core, context);
    // extra metas declared for files not in the PR target existing images in the manifests
    const updateMetas = Array.isArray(extraMetas)
        ? extraMetas.filter((m) => !filePaths.some((filePath) => isImageFileNameMatch(m.fileName!, filePath)))
        : [];

    // applied before processing the changed files, so the changed files are matched against the up-to-date metas
    updateExistingImagesExtraMetas(core, updateMetas, baseManifest, prevManifest);

    for (const filePath of filePaths) {
        core.startGroup(filePath);

        const logPrefix = `[${filePath}]`;
        let failureComment: string | undefined;

        try {
            const firmwareFileName = path.basename(filePath);
            const manufacturer = filePath.replace(BASE_IMAGES_DIR, "").replace(firmwareFileName, "").replaceAll("/", "").trim();

            if (!manufacturer) {
                throw new Error("File should be in its associated manufacturer subfolder");
            }

            const firmwareBuffer = Buffer.from(readFileSync(filePath));
            const parsedImage = parseImageHeader(firmwareBuffer.subarray(firmwareBuffer.indexOf(UPGRADE_FILE_IDENTIFIER)));

            core.info(`${logPrefix} Parsed image header:`);
            core.info(JSON.stringify(parsedImage, undefined, 2));

            const fileExtraMetas = getFileExtraMetas(extraMetas, filePath);

            core.info(`${logPrefix} Extra metas:`);
            core.info(JSON.stringify(fileExtraMetas, undefined, 2));

            const baseOutDir = getOutDir(manufacturer, BASE_IMAGES_DIR);
            const prevOutDir = getOutDir(manufacturer, PREV_IMAGES_DIR);
            const [baseMatchIndex, baseMatch] = findMatchImage(parsedImage, baseManifest, fileExtraMetas);
            const statusToBase = getParsedImageStatus(parsedImage, baseMatch);

            // Manufacturer specific checks
            switch (parsedImage.manufacturerCode) {
                case GLEDOPTO_MANUFACTURER_CODE: {
                    if (
                        !fileExtraMetas.modelId &&
                        (fileExtraMetas.manufacturerName == null ||
                            fileExtraMetas.manufacturerName.some((name) => name.toLowerCase().includes("gledopto")))
                    ) {
                        // Gledopto uses the same imageType for every device, force modelId to be present.
                        // https://github.com/Koenkk/zigbee-OTA/pull/864
                        throw new Error("Gledopto image requires extra `modelId` metadata");
                    }
                    break;
                }
                case TUYA_MANUFACTURER_CODE_1:
                case TUYA_MANUFACTURER_CODE_2: {
                    if (!fileExtraMetas.manufacturerName) {
                        // Tuya uses the same imageType for every device, force manufacturerName to be present.
                        throw new Error("Tuya image requires extra `manufacturerName` metadata");
                    }
                    break;
                }
                case LUMI_UNITED_TECHOLOGY_LTD_SHENZHEN: {
                    if (!fileExtraMetas.modelId) {
                        throw new Error("Lumi/Aqara image requires extra `modelId` metadata");
                    }
                    break;
                }
            }

            switch (statusToBase) {
                case ParsedImageStatus.Older: {
                    // if prev doesn't have a match, move to prev
                    const [prevMatchIndex, prevMatch] = findMatchImage(parsedImage, prevManifest, fileExtraMetas);
                    const statusToPrev = getParsedImageStatus(parsedImage, prevMatch);

                    switch (statusToPrev) {
                        case ParsedImageStatus.Older:
                        case ParsedImageStatus.Identical: {
                            failureComment = `Base manifest has higher version:
\`\`\`json
${JSON.stringify(baseMatch, undefined, 2)}
\`\`\`
and an equal or better match is already present in prev manifest:
\`\`\`json
${JSON.stringify(prevMatch, undefined, 2)}
\`\`\`
Parsed image header:
\`\`\`json
${JSON.stringify(parsedImage, undefined, 2)}
\`\`\``;
                            break;
                        }

                        case ParsedImageStatus.Newer:
                        case ParsedImageStatus.New: {
                            addImageToPrev(
                                logPrefix,
                                statusToPrev === ParsedImageStatus.Newer,
                                prevManifest,
                                prevMatchIndex,
                                prevMatch!,
                                prevOutDir,
                                firmwareFileName,
                                manufacturer,
                                parsedImage,
                                firmwareBuffer,
                                undefined,
                                fileExtraMetas,
                                () => {
                                    // relocate file to prev
                                    renameSync(filePath, filePath.replace(`${BASE_IMAGES_DIR}/`, `${PREV_IMAGES_DIR}/`));
                                },
                            );

                            break;
                        }
                    }

                    break;
                }

                case ParsedImageStatus.Identical: {
                    failureComment = `Conflict with image at index \`${baseMatchIndex}\`:
\`\`\`json
${JSON.stringify(baseMatch, undefined, 2)}
\`\`\`
Parsed image header:
\`\`\`json
${JSON.stringify(parsedImage, undefined, 2)}
\`\`\``;
                    break;
                }

                case ParsedImageStatus.Newer:
                case ParsedImageStatus.New: {
                    addImageToBase(
                        logPrefix,
                        statusToBase === ParsedImageStatus.Newer,
                        prevManifest,
                        prevOutDir,
                        baseManifest,
                        baseMatchIndex,
                        baseMatch!,
                        baseOutDir,
                        firmwareFileName,
                        manufacturer,
                        parsedImage,
                        firmwareBuffer,
                        undefined,
                        fileExtraMetas,
                        () => {
                            /* noop */
                        },
                    );

                    break;
                }
            }
        } catch (error) {
            failureComment = (error as Error).message;
        }

        if (failureComment) {
            core.endGroup();
            throw new Error(`${logPrefix} ${failureComment}`);
        }

        core.endGroup();
    }
}
