// Generated from protocol.schema.json. Do not edit by hand.
export interface Protocol {
    apiError:        APIError;
    createProject:   CreateProject;
    health:          Health;
    project:         Project;
    projectResponse: ProjectResponse;
}

export interface APIError {
    code: string;
}

export interface CreateProject {
    requestId: string;
    title:     string;
}

export interface Health {
    protocolVersion: string;
    status:          string;
}

export interface Project {
    approvedBaseline: number | null;
    id:               string;
    title:            string;
    workingRevision:  number;
}

export interface ProjectResponse {
    project: Project | null;
}
