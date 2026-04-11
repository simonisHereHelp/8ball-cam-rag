// app/components/image-capture-dialog-mobile/useImageCaptureState.ts

import { useRef, useState, useCallback, useEffect } from "react";
import type { WebCameraHandler, FacingMode } from "@shivantra/react-web-camera";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { handleSave } from "@/lib/handleSave";
import { handleSummary } from "@/lib/handleSummary";
import { normalizeFilename } from "@/lib/normalizeFilename";
import {
  CaptureError,
  DEFAULTS,
  normalizeCapture,
} from "../shared/normalizeCapture";
import type {
  Image,
  State,
  Actions,
  SubfolderOption,
  ExtractOutput,
  IngestOutput,
} from "./types";
import {
  applyCanonToSummary,
  fetchIssuerCanonList,
  type IssuerCanonEntry,
} from "./issuerCanonUtils";
import { playSuccessChime } from "./soundEffects";

interface UseImageCaptureState {
  state: State;
  actions: Actions;
  cameraRef: React.RefObject<WebCameraHandler | null>;
}

export const useImageCaptureState = (
  onOpenChange?: (open: boolean) => void,
  initialSource: "camera" | "photos" = "camera",
): UseImageCaptureState => {
  // --- Core State ---
  const [images, setImages] = useState<Image[]>([]);
  const [facingMode, setFacingMode] = useState<FacingMode>("environment");
  const [isSaving, setIsSaving] = useState(false);
  const [isProcessingCapture, setIsProcessingCapture] = useState(false);
  const [showGallery, setShowGallery] = useState(false);
  const [cameraError, setCameraError] = useState(false);
  const [captureSource, setCaptureSource] = useState<"camera" | "photos">(initialSource);

  // --- Summary & AI State ---
  const [draftSummary, setDraftSummary] = useState(""); // Original AI output
  const [editableSummary, setEditableSummary] = useState(""); // User's working text
  const [summaryImageUrl, setSummaryImageUrl] = useState<string | null>(null);
  const [showSummaryOverlay, setShowSummaryOverlay] = useState(false);

  // --- UI Feedback State ---
  const [error, setError] = useState("");
  const [saveMessage, setSaveMessage] = useState("");
  const [extractOutput, setExtractOutput] = useState<ExtractOutput | null>(null);
  const [ingestOutput, setIngestOutput] = useState<IngestOutput | null>(null);
  const [isIngesting, setIsIngesting] = useState(false);
  const [availableSubfolders, setAvailableSubfolders] = useState<SubfolderOption[]>([]);
  const [selectedSubfolder, setSelectedSubfolder] = useState<SubfolderOption | null>(null);
  const [subfolderLoading, setSubfolderLoading] = useState(false);
  const [subfolderError, setSubfolderError] = useState("");

  // --- Canon / Metadata State ---
  const [issuerCanons, setIssuerCanons] = useState<IssuerCanonEntry[]>([]);
  const [issuerCanonsLoading, setIssuerCanonsLoading] = useState(false);
  const [canonError, setCanonError] = useState("");
  const [selectedCanon, setSelectedCanon] = useState<IssuerCanonEntry | null>(null);

  const cameraRef = useRef<WebCameraHandler | null>(null);
  const { data: session } = useSession();
  const router = useRouter();

  // Keep capture source in sync with props
  useEffect(() => {
    setCaptureSource(initialSource);
  }, [initialSource]);

  // --- Handlers ---

  const deleteImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleClose = useCallback(() => {
    if (images.length > 0 && !isSaving) {
      if (!window.confirm("You have unsaved images. Are you sure you want to close?")) {
        return;
      }
    }
    // Reset all state
    setImages([]);
    setDraftSummary("");
    setEditableSummary("");
    setSummaryImageUrl(null);
    setError("");
    setSaveMessage("");
    setExtractOutput(null);
    setIngestOutput(null);
    setIsIngesting(false);
    setShowSummaryOverlay(false);
    setShowGallery(false);
    setAvailableSubfolders([]);
    setSelectedSubfolder(null);
    setSubfolderError("");
    setIssuerCanons([]);
    setCanonError("");
    setSelectedCanon(null);
    setCaptureSource(initialSource);
    setIsProcessingCapture(false);
    onOpenChange?.(false);
  }, [images.length, initialSource, isSaving, onOpenChange]);

  const ingestFile = useCallback(
    async (file: File, source: "camera" | "photos", preferredName?: string) => {
      setIsProcessingCapture(true);
      setError("");
      try {
        const { file: normalizedFile, previewUrl } = await normalizeCapture(file, source, {
          maxFileSize: DEFAULTS.MAX_FILE_SIZE,
          preferredName,
        });

        // Reset summary context for the new set of images
        setSummaryImageUrl(null);
        setDraftSummary("");
        setEditableSummary("");
        setSaveMessage("");
        setExtractOutput(null);
        setIngestOutput(null);
        setShowGallery(false);
        setImages((prev) => [...prev, { url: previewUrl, file: normalizedFile }]);
      } catch (err) {
        setError(err instanceof CaptureError ? err.message : "Unable to process the image.");
      } finally {
        setIsProcessingCapture(false);
      }
    },
    [],
  );

  const handleCapture = useCallback(async () => {
    if (!cameraRef.current) return;
    try {
      const file = await cameraRef.current.capture();
      if (file) await ingestFile(file, "camera", `capture-${Date.now()}.jpeg`);
    } catch (err) {
      setError("Unable to access camera capture.");
    }
  }, [ingestFile]);

  const handleAlbumSelect = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    await ingestFile(files[0], "photos");
  }, [ingestFile]);

  const handleCameraSwitch = useCallback(async () => {
    if (!cameraRef.current) return;
    const newMode = facingMode === "user" ? "environment" : "user";
    await cameraRef.current.switch(newMode);
    setFacingMode(newMode);
  }, [facingMode]);

  const handleSummarize = useCallback(async () => {
    setSaveMessage("");
    setError("");
    setIngestOutput(null);
    
    const setSummaries = (newSummary: string) => {
      setDraftSummary(newSummary);
      setEditableSummary(newSummary); 
    };
    
    const didSummarize = await handleSummary({
      images,
      route: "/api/extract-advanced",
      setIsSaving,
      setSummary: setSummaries,
      setExtractOutput,
      setSummaryImageUrl,
      setShowSummaryOverlay,
      setError,
    });

    if (didSummarize && images.length > 0) {
      setShowGallery(true);
      playSuccessChime();
    }
  }, [images]);

  const refreshCanons = useCallback(async () => {
    if (issuerCanonsLoading) return;
    setIssuerCanonsLoading(true);
    setCanonError("");
    try {
      const entries = await fetchIssuerCanonList();
      setIssuerCanons(entries);
    } catch (err) {
      setCanonError(err instanceof Error ? err.message : "Unable to load canon list.");
    } finally {
      setIssuerCanonsLoading(false);
    }
  }, [issuerCanonsLoading]);

  const refreshSubfolders = useCallback(async () => {
    if (subfolderLoading) return;
    setSubfolderLoading(true);
    setSubfolderError("");
    try {
      const response = await fetch("/api/active-subfolders");
      if (!response.ok) {
        throw new Error("Unable to load subfolder options.");
      }
      const json = (await response.json().catch(() => null)) as
        | { subfolders?: SubfolderOption[] }
        | null;
      setAvailableSubfolders(json?.subfolders ?? []);
    } catch (err) {
      setSubfolderError(err instanceof Error ? err.message : "Unable to load subfolder options.");
    } finally {
      setSubfolderLoading(false);
    }
  }, [subfolderLoading]);

  const selectSubfolder = useCallback((subfolder: SubfolderOption) => {
    setSelectedSubfolder(subfolder);
    setIngestOutput((current) =>
      current
        ? {
            ...current,
            subject_category: subfolder.topic,
          }
        : current,
    );
  }, []);

  const buildEditedExtractOutput = useCallback((): ExtractOutput | null => {
    if (!extractOutput) return null;

    const editedText = editableSummary.trim();
    if (!editedText) {
      return {
        ...extractOutput,
        markdown: "",
        plainText: "",
      };
    }

    return {
      ...extractOutput,
      markdown: editableSummary,
      plainText: editableSummary,
    };
  }, [editableSummary, extractOutput]);

  const handleEditableSummaryChange = useCallback((summary: string) => {
    setEditableSummary(summary);
    setExtractOutput((current) =>
      current
        ? {
            ...current,
            markdown: summary,
            plainText: summary,
          }
        : current,
    );
    setIngestOutput(null);
  }, []);

  const selectCanon = useCallback((canon: IssuerCanonEntry) => {
    setSelectedCanon(canon);
    setIngestOutput((current) =>
      current
        ? {
            ...current,
            issuer_name: canon.master,
          }
        : current,
    );
  }, []);

  // Auto-refresh canons when gallery opens
  useEffect(() => {
    if (showGallery && !issuerCanons.length && !issuerCanonsLoading) {
      refreshCanons();
    }
  }, [showGallery, issuerCanons.length, issuerCanonsLoading, refreshCanons]);

  useEffect(() => {
    if (showGallery && !availableSubfolders.length && !subfolderLoading) {
      refreshSubfolders();
    }
  }, [showGallery, availableSubfolders.length, subfolderLoading, refreshSubfolders]);

  const handleIngest = useCallback(async () => {
    if (isIngesting || !extractOutput) return;

    setIsIngesting(true);
    setError("");

    try {
      const currentExtractOutput = buildEditedExtractOutput();
      if (!currentExtractOutput) {
        throw new Error("No extracted text is available to ingest.");
      }

      const response = await fetch("/api/ingest", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(currentExtractOutput),
      });

      const payload = (await response.json().catch(() => null)) as
        | { error?: string; ingestOutput?: IngestOutput }
        | IngestOutput
        | null;

      if (!response.ok) {
        throw new Error(
          payload && "error" in payload ? payload.error || "Unable to ingest document." : "Unable to ingest document.",
        );
      }

      let resolvedOutput: IngestOutput | null = null;

      if (payload && typeof payload === "object" && "ingestOutput" in payload) {
        resolvedOutput = payload.ingestOutput ?? null;
      } else {
        resolvedOutput = payload as IngestOutput | null;
      }

      if (!resolvedOutput) {
        throw new Error("Ingest endpoint returned an empty response.");
      }

      if (selectedCanon) {
        resolvedOutput = {
          ...resolvedOutput,
          issuer_name: selectedCanon.master,
        };
      }

      if (selectedSubfolder) {
        resolvedOutput = {
          ...resolvedOutput,
          subject_category: selectedSubfolder.topic,
        };
      }

      setIngestOutput(resolvedOutput);
      playSuccessChime();
    } catch (err) {
      console.error("Failed to ingest document:", err);
      setError(err instanceof Error ? err.message : "Unable to ingest document.");
    } finally {
      setIsIngesting(false);
    }
  }, [buildEditedExtractOutput, extractOutput, isIngesting, selectedCanon, selectedSubfolder]);

  const handleSaveImages = useCallback(async () => {
    if (!session || isSaving) return;

    if (!ingestOutput) {
      setError("Please run Ingest before saving.");
      return;
    }

    setSaveMessage("");
    setError("");

    await handleSave({
      images,
      ingestOutputJson: JSON.stringify(ingestOutput, null, 2),
      selectedCanon,
      selectedSubfolder,
      setIsSaving,
      onError: setError,
      onSuccess: ({ setName, targetFolderId, topic }) => {
        setShowGallery(false);
        const folderPath = topic || targetFolderId?.split("/").pop() || "Drive";
        const displayPath = folderPath.replace(/^Drive_/, "");
        const resolvedName = normalizeFilename(setName || "(untitled)");
        
        sessionStorage.setItem(
          "uploadConfirmation",
          JSON.stringify({ folder: displayPath, filename: resolvedName }),
        );
        window.dispatchEvent(new Event("upload-confirmation"));
        setSaveMessage(`uploaded to: ${displayPath} ✅\nname: ${resolvedName} ✅`);
        setImages([]);
        setDraftSummary("");
        setEditableSummary("");
        setExtractOutput(null);
        setIngestOutput(null);
        setSelectedCanon(null);
        setSelectedSubfolder(null);
        playSuccessChime();
        onOpenChange?.(false);
        router.push("/");
      },
    });
  }, [
    session,
    isSaving,
    ingestOutput,
    images,
    selectedCanon,
    selectedSubfolder,
    onOpenChange,
    router,
  ]);

  // --- Aggregate State & Actions ---

  const state: State = {
    images,
    facingMode,
    isSaving,
    isProcessingCapture,
    showGallery,
    cameraError,
    captureSource,
    draftSummary,
    editableSummary,
    summaryImageUrl,
    error,
    saveMessage,
    extractOutput,
    ingestOutput,
    isIngesting,
    availableSubfolders,
    selectedSubfolder,
    subfolderLoading,
    subfolderError,
    showSummaryOverlay,
    issuerCanons,
    issuerCanonsLoading,
    canonError,
    selectedCanon,
  };

  const actions: Actions = {
    deleteImage,
    handleCapture,
    handleAlbumSelect,
    handleCameraSwitch,
    handleSummarize,
    handleIngest,
    handleSaveImages,
    handleClose,
    setCaptureSource,
    setEditableSummary: handleEditableSummaryChange,
    setDraftSummary,
    setShowGallery,
    setCameraError,
    setError,
    setCanonError,
    refreshSubfolders,
    selectSubfolder,
    refreshCanons,
    selectCanon,
  };

  return { state, actions, cameraRef };
};
